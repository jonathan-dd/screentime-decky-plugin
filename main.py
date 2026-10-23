# ScreenTime - Decky-Loader-Plugin
# Python-Backend: Zustandsmaschine für erzwungene Spielpausen auf der Steam Deck.
#
# Zeitlogik: Der Plugin-Prozess friert beim System-Suspend ein —
# time.monotonic() zählt nur Wachzeit, time.time() (Wanduhr) läuft weiter.
# Spielzeit wird daher über monotonic aufsummiert (Schlafzeit zählt nicht),
# die 10-Minuten-Pause zählt in Wanduhr ab der ersten Suspension
# (inklusive Schlafzeit). Suspend/Wake wird über einen Wanduhr-Sprung
# von mehr als 30 Sekunden zwischen zwei Ticks erkannt.

import asyncio
import base64
import hashlib
import hmac
import json
import math
import os
import time
from typing import Any, Dict, Optional

import decky

# --- Konstanten des Verhaltens (siehe README) ---
# Die Zeit-Werte (Sitzung/Pause/Limit/Vorwarnung) sind jetzt einstellbar
# (siehe SETTING_SPECS); die Defaults entsprechen den bisherigen Werten.
MANUAL_SUSPEND_GAP_S = 30.0     # Wanduhr-Sprung > 30 s zwischen Ticks => Suspend/Wake
TOAST_AFTER_WAKE_S = 20.0       # In der Pause: Toast erst nach 20 Sekunden Wachzeit
RESUSPEND_AFTER_TOAST_S = 10.0  # In der Pause: 10 s nach dem Toast erneut Ruhemodus
SUSPEND_RETRY_S = 5.0           # Suspend fehlgeschlagen => alle 5 s erneut anfordern
TICK_S = 1.0                    # Tick-Intervall des Hintergrund-Loops
PERSIST_DEBOUNCE_S = 10.0       # Statusdatei sparsam schreiben: max. alle 10 s
STATE_FILE = 'state.json'

# --- PIN-Schutz ---
# Einstellungen und der Aktiv-Schalter sind gesperrt, bis per PIN entsperrt
# wurde. Nach dem Entsperren bleibt das Panel 10 Minuten offen; jede
# geschützte Aktion setzt die Frist neu.
PIN_FILE = 'pin.json'           # bewusst SEPARAT von state.json: 'PIN vergessen'
                                # => pin.json per Konsole löschen => Setup-Flow
PIN_ITERATIONS = 100_000        # PBKDF2-HMAC-SHA256
PIN_SALT_BYTES = 16             # 16-Byte-Random-Salt
PIN_MIN_LEN = 4
PIN_MAX_LEN = 8
UNLOCK_TIMEOUT_S = 600.0        # 10 Minuten offen nach Unlock/geschützter Aktion
LOCKOUT_S = 60.0                # 60 s Sperre nach 5 fehlgeschlagenen Versuchen
MAX_FAILED_UNLOCK = 5

# Einstellbare Werte: Key -> (Default, min, max). Minuten bzw. Sekunden.
# Das Backend clampt JEDES Mal (IPC und Laden) — Frontend-Angaben werden
# nie vertraut.
SETTING_SPECS: Dict[str, Any] = {
    'session_minutes':         (20, 5, 180),
    'break_minutes':           (10, 5, 120),
    'daily_limit_minutes':     (120, 30, 720),
    'reduced_session_minutes': (5, 1, 60),
    'warn_before_seconds':     (60, 15, 300),
}
DEFAULT_SETTINGS: Dict[str, int] = {k: spec[0] for k, spec in SETTING_SPECS.items()}

STATE_IDLE = 'idle'
STATE_PLAYING = 'playing'
STATE_BREAKING = 'breaking'


class Plugin:
    """Backend-Zustandsmaschine, vom Decky-Loader instanziiert.

    IPC-Methoden (aus dem Frontend via @decky/api callable aufrufbar):
      - set_game_running(is_running): Frontend meldet Start/Stop einer Steam-App
      - set_enabled(enabled):         Plugin an/aus (persistiert, PIN-geschützt)
      - get_state():                  Status für das QAM-Panel
      - get_settings()/set_settings(): Einstellungen lesen/ändern (ändern: geschützt)
      - pin_status():                 PIN-Zustand (offen/lesend)
      - setup_pin(pin):               Erste PIN festlegen (nur solange keine existiert)
      - unlock(pin)/lock():           Entsperren (Rate-Limit) / manuell sperren
      - set_pin(current_pin, new_pin): PIN ändern (braucht Unlock + aktuelle PIN)
    """

    def __init__(self):
        self.loop = None
        self._tick_task = None
        # Persistierter Zustand
        self.enabled = True
        self.total_today_s = 0.0
        self.day = time.strftime('%Y-%m-%d')
        self.settings: Dict[str, int] = dict(DEFAULT_SETTINGS)
        # Laufzeitzustand
        self.state = STATE_IDLE
        self.game_running = False
        self.session_s = 0.0          # Wachzeit der aktuellen Sitzung
        self.warned = False           # Vorankündigung für diese Sitzung gezeigt?
        self.break_start_wall = 0.0   # Wanduhr-Zeitpunkt des Pausenbeginns
        self.awake_s = 0.0            # Wachzeit seit dem letzten Wake (in der Pause)
        self.suspend_pending = False  # Suspend ausgelöst, auf Wake warten
        # Wachzeit-Marke des letzten suspend_now-Emits (Tick-basiert, zur
        # Retry-Logik in der Pause): seit dieser Marke >= 5 s wach => erneut emit.
        self.last_suspend_emit = 0.0
        self.break_toast_shown = False
        # Zeitmarker des letzten Ticks
        self.last_wall = time.time()
        self.last_mono = time.monotonic()
        self._last_persist_wall = 0.0
        # PIN-Gate (nur In-Memory, nicht persistiert)
        self.unlocked_until = 0.0     # Wanduhr; 0.0 = gesperrt
        self.failed_unlocks = 0
        self.lockout_until = 0.0      # Wanduhr; 0.0 = kein Lockout

    # --- Persistenz ---

    def _persist_dir(self) -> str:
        """Verzeichnis der Statusdatei; bevorzugt die Plugin-Runtime-Dir des Loaders."""
        d = getattr(decky, 'DECKY_PLUGIN_RUNTIME_DIR', None)
        if not d:
            base = getattr(decky, 'DECKY_RUNTIME_DIR', decky.DECKY_HOME)
            d = os.path.join(base, 'screentime-decky-plugin')
        os.makedirs(d, exist_ok=True)
        return d

    def _state_path(self) -> str:
        return os.path.join(self._persist_dir(), STATE_FILE)

    def _load_state(self) -> None:
        """Gespeicherten Stand beim Start laden; fehlende/kaputte Datei => Defaults."""
        try:
            with open(self._state_path(), 'r', encoding='utf-8') as f:
                data = json.load(f)
        except (OSError, ValueError):
            return
        if not isinstance(data, dict):
            return
        self.enabled = bool(data.get('enabled', True))
        today = time.strftime('%Y-%m-%d')
        if data.get('day') == today:
            # Gleicher Tag: kumulierte Spielzeit übernehmen.
            self.day = today
            try:
                self.total_today_s = max(0.0, float(data.get('total_play_seconds', 0.0)))
            except (TypeError, ValueError):
                self.total_today_s = 0.0
        else:
            # Gespeicherter Stand gehört zu einem früheren Tag: Tageszähler
            # um Mitternacht zurücksetzen.
            self.day = today
            self.total_today_s = 0.0
        # Einstellungen: fehlende Keys => Default; Werte clampen (Hand-Edit
        # einer kaputten state.json soll nie außerhalb der Ranges landen).
        saved_settings = data.get('settings')
        if isinstance(saved_settings, dict):
            merged: Dict[str, int] = dict(DEFAULT_SETTINGS)
            for key, (_default, lo, hi) in SETTING_SPECS.items():
                if key in saved_settings:
                    merged[key] = self._clamp_value(saved_settings[key], lo, hi,
                                                    _default)
            self.settings = merged
        break_start = data.get('breaking_start_wall')
        if isinstance(break_start, (int, float)) and break_start > 0:
            # Unterbrochene Pause über einen Plugin-Neustart hinweg fortführen;
            # der erste Tick beendet sie, falls sie längst um ist.
            self.state = STATE_BREAKING
            self.break_start_wall = float(break_start)

    @staticmethod
    def _clamp_value(raw: Any, lo: int, hi: int, fallback: int) -> int:
        """Einzelnen Einstellungs-Wert in [lo, hi] zwingen; unbrauchbar
        (keine Zahl, NaN/inf) => fallback."""
        try:
            val = float(raw)
        except (TypeError, ValueError):
            return fallback
        if not math.isfinite(val):
            return fallback
        return int(round(min(float(hi), max(float(lo), val))))

    def _persist_state(self, now_wall: float) -> None:
        """Status atomar als JSON schreiben (tmp-Datei + os.replace)."""
        data: Dict[str, Any] = {
            'day': self.day,
            'total_play_seconds': round(self.total_today_s, 3),
            'enabled': self.enabled,
            'settings': dict(self.settings),
        }
        if self.state == STATE_BREAKING:
            data['breaking_start_wall'] = self.break_start_wall
        path = self._state_path()
        tmp = path + '.tmp'
        try:
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(data, f)
            os.replace(tmp, path)  # atomar: nie eine halbe Datei hinterlassen
        except OSError:
            decky.logger.exception('ScreenTime: Konnte die Statusdatei nicht schreiben.')

    def _maybe_persist(self, now_wall: float, force: bool = False) -> None:
        """Debounce: höchstens alle 10 s schreiben; final in _unload erzwingen."""
        if force or (now_wall - self._last_persist_wall) >= PERSIST_DEBOUNCE_S:
            self._persist_state(now_wall)
            self._last_persist_wall = now_wall

    # --- Einstellungen (live gelesen, überall geclampt) ---

    def _setting_s(self, key: str) -> float:
        """Minuten-Einstellung in Sekunden."""
        return float(self.settings.get(key, DEFAULT_SETTINGS[key])) * 60.0

    def _warn_before_s(self) -> float:
        return float(self.settings.get('warn_before_seconds',
                                       DEFAULT_SETTINGS['warn_before_seconds']))

    def _current_limit_s(self) -> float:
        """Sitzungslänge: verkürzt, sobald das Tageslimit erreicht ist.

        Live aus den Settings gelesen — Werte gelten sofort: Wird die
        Sitzungslänge mitten in einer laufenden Sitzung unterschritten,
        endet die Sitzung beim nächsten Tick (konsistent mit dem
        bestehenden 2h-Cross-Trigger, der eine Sitzung ebenfalls mitten
        drin beendet, wenn kumulativ das Tageslimit erreicht wird).
        """
        if self.total_today_s >= self._setting_s('daily_limit_minutes'):
            return self._setting_s('reduced_session_minutes')
        return self._setting_s('session_minutes')

    # --- PIN-Handling (eigene Datei pin.json, atomar, stdlib-only) ---

    def _pin_path(self) -> str:
        return os.path.join(self._persist_dir(), PIN_FILE)

    def _load_pin_file(self) -> Optional[Dict[str, Any]]:
        """PIN-Datei lesen. Fehlt sie oder ist sie kaputt => None
        (= kein PIN konfiguriert, Panel zeigt den Setup-Flow)."""
        try:
            with open(self._pin_path(), 'r', encoding='utf-8') as f:
                data = json.load(f)
        except (OSError, ValueError):
            return None
        if not isinstance(data, dict):
            return None
        if not data.get('pin_salt_b64') or not data.get('pin_hash_b64'):
            return None
        return data

    def _save_pin_file(self, record: Dict[str, Any]) -> None:
        """PIN-Datei atomar schreiben (tmp + os.replace)."""
        path = self._pin_path()
        tmp = path + '.tmp'
        try:
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(record, f)
            os.replace(tmp, path)
        except OSError:
            decky.logger.exception('ScreenTime: Konnte die PIN-Datei nicht schreiben.')

    def _hash_pin(self, pin: str, salt: bytes) -> bytes:
        return hashlib.pbkdf2_hmac('sha256', pin.encode('utf-8'), salt,
                                   PIN_ITERATIONS)

    @staticmethod
    def _valid_pin_len(pin: Any) -> bool:
        return isinstance(pin, str) and PIN_MIN_LEN <= len(pin) <= PIN_MAX_LEN

    def _verify_pin(self, pin: str) -> bool:
        """PIN gegen pin.json prüfen (constant-time Vergleich)."""
        record = self._load_pin_file()
        if record is None:
            return False
        try:
            salt = base64.b64decode(record['pin_salt_b64'])
            expected = base64.b64decode(record['pin_hash_b64'])
        except (KeyError, TypeError, ValueError):
            return False
        return hmac.compare_digest(self._hash_pin(pin, salt), expected)

    def _pin_record(self, pin: str) -> Dict[str, Any]:
        salt = os.urandom(PIN_SALT_BYTES)
        return {
            'pin_salt_b64': base64.b64encode(salt).decode('ascii'),
            'pin_hash_b64': base64.b64encode(self._hash_pin(pin, salt)).decode('ascii'),
            'iterations': PIN_ITERATIONS,
            'created_at': time.time(),
        }

    def _is_unlocked(self, now_wall: float) -> bool:
        """Vorprüfung für jeden geschützten Call: PIN konfiguriert,
        10-Min-Fenster offen und kein aktiver Lockout."""
        if self._load_pin_file() is None:
            return False
        return now_wall < self.unlocked_until and now_wall >= self.lockout_until

    async def _tick_once(self) -> None:
        now_wall = time.time()
        now_mono = time.monotonic()
        gap = now_wall - self.last_wall
        delta_mono = max(0.0, now_mono - self.last_mono)

        # 1) Wanduhr-Sprung > 30 s: Das Gerät war im Suspend (der Prozess war
        #    eingefroren, ein Tick hat die Schlafzeit nicht gesehen).
        if gap > MANUAL_SUSPEND_GAP_S:
            # Wake erkannt: Suspend wurde bestätigt — Suspend-Flags und
            # Retry-Marke für den neuen Wach-Zyklus zurücksetzen.
            self.suspend_pending = False
            self.last_suspend_emit = 0.0
            if self.state == STATE_PLAYING:
                if self.warned:
                    # Manueller Ruhemodus nach der Vorankündigung: Die Pause
                    # beginnt zum Zeitpunkt der Suspension — die Schlafzeit
                    # zählt mit zur Pause.
                    self.state = STATE_BREAKING
                    self.break_start_wall = self.last_wall
                    self.awake_s = 0.0
                    self.break_toast_shown = False
                else:
                    # Manueller Sleep vor der Warn-Marke: Sitzung verwerfen,
                    # der Timer startet beim Aufwachen neu.
                    self.session_s = 0.0
                    self.warned = False
            elif self.state == STATE_BREAKING:
                # Nach dem Aufwachen: Wachzeit neu messen, Pause-Toast erneut zeigen.
                self.awake_s = 0.0
                self.break_toast_shown = False

        # Zeitmarker für den nächsten Tick nachziehen.
        self.last_wall = now_wall
        self.last_mono = now_mono

        # 2) Datumswechsel: Tageszähler um Mitternacht zurücksetzen.
        today = time.strftime('%Y-%m-%d')
        if today != self.day:
            self.day = today
            self.total_today_s = 0.0

        # 3) Deaktiviert: Zustandsmaschine ruhig lassen.
        if not self.enabled:
            return

        # 4) Spiel geschlossen, während eine Sitzung lief: Sitzung verwerfen.
        #    (Eine laufende Pause läuft weiter, auch wenn das Spiel
        #    geschlossen wird.)
        if not self.game_running and self.state == STATE_PLAYING:
            self.state = STATE_IDLE
            self.session_s = 0.0
            self.warned = False

        # 5) Zustandsmaschine
        if self.state == STATE_BREAKING:
            # Erzwungene Pause: zählt in Wanduhr ab der ersten Suspension.
            # (Wird nie abgebrochen — auch nicht durch Entsperren; die Länge
            # wird live aus den Settings gelesen.)
            break_s = self._setting_s('break_minutes')
            elapsed = now_wall - self.break_start_wall
            if elapsed >= break_s:
                # Pause vorüber: neue (evtl. verkürzte) Sitzung beginnen.
                limit = self._current_limit_s()
                self.state = STATE_PLAYING if self.game_running else STATE_IDLE
                self.session_s = 0.0
                self.warned = False
                # Pause-Ende: alle Pausen-Marker inkl. Suspend-Retry zurücksetzen.
                self.suspend_pending = False
                self.last_suspend_emit = 0.0
                self.break_toast_shown = False
                await decky.emit('break_over', int(limit // 60))
            else:
                self.awake_s += delta_mono
                if self.awake_s >= TOAST_AFTER_WAKE_S and not self.break_toast_shown:
                    # Nur kurz wach lassen, damit der Toast lesbar ist.
                    self.break_toast_shown = True
                    remaining_min = max(1, math.ceil((break_s - elapsed) / 60))
                    await decky.emit('show_break_toast', remaining_min)
                if (self.awake_s >= TOAST_AFTER_WAKE_S + RESUSPEND_AFTER_TOAST_S
                        and (not self.suspend_pending
                             or (self.awake_s - self.last_suspend_emit) >= SUSPEND_RETRY_S)):
                    # Erneut in den Ruhemodus, bis die Pause um ist. suspend_pending
                    # sorgt nur für den ersten Emit sofort nach dem Wake (Toast bleibt
                    # davor lesbar); ist das Gerät danach weiterhin wach, ist der
                    # Suspend fehlgeschlagen => alle 5 s erneut anfordern, bis der
                    # Wanduhr-Sprung den Suspend bestätigt (Retry-Marke last_suspend_emit).
                    self.suspend_pending = True
                    self.last_suspend_emit = self.awake_s
                    await decky.emit('suspend_now')
        elif self.game_running:
            if self.state == STATE_IDLE:
                self.state = STATE_PLAYING
                self.session_s = 0.0
                self.warned = False
            if self.state == STATE_PLAYING:
                # Nur Wachzeit zählen (monotonic friert beim Suspend ein).
                total_before = self.total_today_s
                self.session_s += delta_mono
                self.total_today_s += delta_mono
                limit = self._current_limit_s()
                warn_before = self._warn_before_s()
                daily_limit = self._setting_s('daily_limit_minutes')
                if (not self.warned
                        and (self.session_s >= limit - warn_before
                             or (total_before < daily_limit
                                 and (daily_limit - self.total_today_s) <= warn_before))):
                    # Vorankündigung: kurz vor Sitzungsende oder kurz davor,
                    # dass kumulativ das Tageslimit des Tages erreicht wird.
                    self.warned = True
                    await decky.emit('show_warning')
                if (self.session_s >= limit
                        or (total_before < daily_limit
                            and self.total_today_s >= daily_limit)):
                    # Sitzungsende — auch mitten in der Sitzung, wenn kumulativ
                    # das Tageslimit erreicht wird ODER wenn die (jetzt
                    # konfigurierbare) Sitzungslänge mitten in der Sitzung
                    # unterschritten wird: Neue Werte gelten sofort, die
                    # laufende Sitzung endet beim nächsten Tick.
                    self.state = STATE_BREAKING
                    self.break_start_wall = now_wall
                    self.awake_s = 0.0
                    self.break_toast_shown = False
                    # Erster Suspend beim Sitzungsende — bleibt wie er ist. Schlägt er
                    # fehl (Gerät bleibt wach), greift ab awake_s >= 30 (Toast nach 20 s
                    # + 10 s) die Retry-Logik unten: alle 5 s erneut, bis der
                    # Wanduhr-Sprung den Suspend bestätigt. D. h. bis zu 30 s
                    # Verzögerung beim Session-Ende-Suspend, dann Retry alle 5 s.
                    self.suspend_pending = True
                    self.last_suspend_emit = 0.0
                    await decky.emit('suspend_now')

        # 6) Persistenz (debounced, max. alle 10 s).
        self._maybe_persist(now_wall)

    async def _tick_loop(self) -> None:
        """Sekündlicher Hintergrund-Tick. Ein Fehler in einem einzelnen Tick
        darf den Loop nicht beenden (try/except pro Iteration)."""
        while True:
            try:
                await self._tick_once()
            except Exception:
                decky.logger.exception('ScreenTime: Fehler im Sekunden-Tick.')
                # Zeitmarker nachziehen, damit die Fehlerpause nicht als
                # Suspend/Wake missdeutet wird.
                self.last_wall = time.time()
                self.last_mono = time.monotonic()
                # Suspend-Retry-Marke ebenfalls nachziehen: nach einem Fehler-Tick
                # im 5-s-Rhythmus neu starten statt sofort erneut zu emit.
                self.last_suspend_emit = self.awake_s
            await asyncio.sleep(TICK_S)

    # --- Lifecycle (vom Decky-Loader aufgerufen) ---

    async def _main(self) -> None:
        """Beim Laden des Plugins: gespeicherten Stand laden, Tick-Loop starten."""
        self.loop = asyncio.get_event_loop()
        self.last_wall = time.time()
        self.last_mono = time.monotonic()
        self._load_state()
        decky.logger.info(
            'ScreenTime: Plugin geladen (aktiv=%s, Status=%s, heute gespielt: %.0f s).',
            self.enabled, self.state, self.total_today_s,
        )
        self._tick_task = asyncio.create_task(self._tick_loop())

    async def _unload(self) -> None:
        """Beim Entladen: Tick-Loop sauber abbrechen, Stand final speichern."""
        if self._tick_task is not None:
            self._tick_task.cancel()
            try:
                await self._tick_task
            except asyncio.CancelledError:
                pass
            self._tick_task = None
        now_wall = time.time()
        self._persist_state(now_wall)
        self._last_persist_wall = now_wall
        decky.logger.info('ScreenTime: Plugin entladen.')

    async def _uninstall(self) -> None:
        decky.logger.info('ScreenTime: Plugin deinstalliert.')

    # --- IPC (vom Frontend aufrufbar) ---

    async def set_game_running(self, is_running: bool) -> None:
        """Frontend meldet, ob gerade eine Steam-App (Spiel) läuft."""
        self.game_running = bool(is_running)

    async def pin_status(self) -> Dict[str, Any]:
        """PIN-Zustand für das Panel (offen/lesend, alle 2 s gepollt)."""
        now = time.time()
        return {
            'configured': self._load_pin_file() is not None,
            'unlocked': self._is_unlocked(now),
            'lockout_remaining_s': round(max(0.0, self.lockout_until - now), 1),
        }

    async def setup_pin(self, pin: Any) -> bool:
        """Erste PIN festlegen — nur solange noch keine existiert."""
        if self._load_pin_file() is not None or not self._valid_pin_len(pin):
            return False
        self._save_pin_file(self._pin_record(pin))
        # Bewusst NUR die Tatsache loggen: Klartext-PIN und Hash dürfen
        # nie in Logzeilen landen.
        decky.logger.info('ScreenTime: PIN eingerichtet.')
        return True

    async def unlock(self, pin: Any) -> bool:
        """Entsperren. 5 Fehlversuche => 60 s Lockout; Erfolg resettet den
        Fehlversuch-Zähler und öffnet das 10-Min-Fenster."""
        now = time.time()
        if now < self.lockout_until:
            return False  # Lockout aktiv
        if not isinstance(pin, str) or not self._verify_pin(pin):
            self.failed_unlocks += 1
            if self.failed_unlocks >= MAX_FAILED_UNLOCK:
                self.lockout_until = now + LOCKOUT_S
                # Zähler in die Sperr-Phase gefaltet: nach Ablauf gibt es
                # wieder 5 frische Versuche.
                self.failed_unlocks = 0
            return False
        self.failed_unlocks = 0
        self.unlocked_until = now + UNLOCK_TIMEOUT_S
        return True

    async def lock(self) -> None:
        """Manuell sperren (offen; wirft das Unlock-Fenster sofort zu)."""
        self.unlocked_until = 0.0

    async def set_pin(self, current_pin: Any, new_pin: Any) -> bool:
        """PIN ändern — braucht ein offenes Unlock-Fenster UND die korrekte
        aktuelle PIN."""
        if not self._is_unlocked(time.time()):
            return False
        if not isinstance(current_pin, str) or not self._verify_pin(current_pin):
            return False
        if not self._valid_pin_len(new_pin):
            return False
        self._save_pin_file(self._pin_record(new_pin))
        # Geschützte Aktion: 10-Min-Frist neu setzen.
        self.unlocked_until = time.time() + UNLOCK_TIMEOUT_S
        decky.logger.info('ScreenTime: PIN geändert.')
        return True

    async def get_settings(self) -> Dict[str, Any]:
        """Aktuelle Einstellungen (offen/lesend, für die Slider-Anzeige)."""
        return dict(self.settings)

    async def set_settings(self, settings: Any) -> Dict[str, Any]:
        """Einstellungen ändern (geschützt). Jeder Wert wird serverseitig
        geclampt — das Backend vertraut den Frontend-Angaben nie. Gesperrt
        (oder ungültiges Argument) => leeres dict."""
        now = time.time()
        if not self._is_unlocked(now):
            return {}
        if not isinstance(settings, dict):
            return {}
        accepted: Dict[str, int] = {}
        for key, (_default, lo, hi) in SETTING_SPECS.items():
            # Aktueller Wert als Fallback: ungültige Mitgaben ändern nichts,
            # nicht mitgeschickte Keys bleiben unverändert.
            current = self._clamp_value(self.settings.get(key, _default), lo, hi,
                                        _default)
            if key in settings:
                accepted[key] = self._clamp_value(settings[key], lo, hi, current)
            else:
                accepted[key] = current
        self.settings = accepted
        # Geschützte Aktion: 10-Min-Frist neu setzen.
        self.unlocked_until = now + UNLOCK_TIMEOUT_S
        # Einstellungen sind selten — sofort sichern statt auf den Debounce
        # zu warten (wie bei set_enabled).
        self._persist_state(now)
        self._last_persist_wall = now
        return dict(accepted)

    async def set_enabled(self, enabled: bool) -> bool:
        """Plugin aktivieren/deaktivieren (wird persistiert).
        Geschützt: braucht ein offenes Unlock-Fenster, sonst False."""
        if not self._is_unlocked(time.time()):
            return False
        self.enabled = bool(enabled)
        decky.logger.info('ScreenTime: Aktiv=%s.', self.enabled)
        # Aktivierungs-Änderung sofort sichern, nicht erst nach dem Debounce.
        now_wall = time.time()
        self._persist_state(now_wall)
        self._last_persist_wall = now_wall
        # Geschützte Aktion: 10-Min-Frist neu setzen.
        self.unlocked_until = now_wall + UNLOCK_TIMEOUT_S
        return True

    async def get_state(self) -> Dict[str, Any]:
        """Aktueller Status für das QAM-Panel (wird alle 2 s gepollt)."""
        limit = self._current_limit_s()
        now_wall = time.time()
        if self.state == STATE_PLAYING:
            session_remaining_s = max(0.0, limit - self.session_s)
        else:
            session_remaining_s = 0.0
        if self.state == STATE_BREAKING:
            break_remaining_s = max(0.0, self._setting_s('break_minutes')
                                    - (now_wall - self.break_start_wall))
        else:
            break_remaining_s = 0.0
        return {
            'enabled': self.enabled,
            'state': self.state,
            'game_running': self.game_running,
            'session_remaining_s': round(session_remaining_s, 1),
            'break_remaining_s': round(break_remaining_s, 1),
            'total_play_min_today': int(round(self.total_today_s / 60.0)),
            'limit_min': int(limit // 60),
            'pin_configured': self._load_pin_file() is not None,
            'pin_unlocked': self._is_unlocked(now_wall),
        }
