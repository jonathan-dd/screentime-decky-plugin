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
import json
import math
import os
import time
from typing import Any, Dict

import decky

# --- Konstanten des Verhaltens (siehe README) ---
SESSION_NORMAL_S = 1200.0       # Normale Sitzungslänge: 20 Minuten
SESSION_REDUCED_S = 300.0       # Verkürzte Sitzung nach erreichtem Tageslimit: 5 Minuten
BREAK_S = 600.0                 # Erzwungene Pause: 10 Minuten (Wanduhr, inkl. Schlafzeit)
WARN_BEFORE_S = 60.0            # Vorankündigung: 60 Sekunden vor Sitzungsende
DAILY_LIMIT_S = 7200.0          # Tageslimit: 2 Stunden Spielzeit
MANUAL_SUSPEND_GAP_S = 30.0     # Wanduhr-Sprung > 30 s zwischen Ticks => Suspend/Wake
TOAST_AFTER_WAKE_S = 20.0       # In der Pause: Toast erst nach 20 Sekunden Wachzeit
RESUSPEND_AFTER_TOAST_S = 10.0  # In der Pause: 10 s nach dem Toast erneut Ruhemodus
TICK_S = 1.0                    # Tick-Intervall des Hintergrund-Loops
PERSIST_DEBOUNCE_S = 10.0       # Statusdatei sparsam schreiben: max. alle 10 s
STATE_FILE = 'state.json'

STATE_IDLE = 'idle'
STATE_PLAYING = 'playing'
STATE_BREAKING = 'breaking'


class Plugin:
    """Backend-Zustandsmaschine, vom Decky-Loader instanziiert.

    IPC-Methoden (aus dem Frontend via @decky/api callable aufrufbar):
      - set_game_running(is_running): Frontend meldet Start/Stop einer Steam-App
      - set_enabled(enabled):         Plugin an/aus (persistiert)
      - get_state():                  Status für das QAM-Panel
    """

    def __init__(self):
        self.loop = None
        self._tick_task = None
        # Persistierter Zustand
        self.enabled = True
        self.total_today_s = 0.0
        self.day = time.strftime('%Y-%m-%d')
        # Laufzeitzustand
        self.state = STATE_IDLE
        self.game_running = False
        self.session_s = 0.0          # Wachzeit der aktuellen Sitzung
        self.warned = False           # Vorankündigung für diese Sitzung gezeigt?
        self.break_start_wall = 0.0   # Wanduhr-Zeitpunkt des Pausenbeginns
        self.awake_s = 0.0            # Wachzeit seit dem letzten Wake (in der Pause)
        self.suspend_pending = False  # Suspend ausgelöst, auf Wake warten
        self.break_toast_shown = False
        # Zeitmarker des letzten Ticks
        self.last_wall = time.time()
        self.last_mono = time.monotonic()
        self._last_persist_wall = 0.0

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
        break_start = data.get('breaking_start_wall')
        if isinstance(break_start, (int, float)) and break_start > 0:
            # Unterbrochene Pause über einen Plugin-Neustart hinweg fortführen;
            # der erste Tick beendet sie, falls sie längst um ist.
            self.state = STATE_BREAKING
            self.break_start_wall = float(break_start)

    def _persist_state(self, now_wall: float) -> None:
        """Status atomar als JSON schreiben (tmp-Datei + os.replace)."""
        data: Dict[str, Any] = {
            'day': self.day,
            'total_play_seconds': round(self.total_today_s, 3),
            'enabled': self.enabled,
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

    # --- Zustands-Logik ---

    def _current_limit_s(self) -> float:
        """Sitzungslänge: verkürzt, sobald das Tageslimit erreicht ist."""
        if self.total_today_s >= DAILY_LIMIT_S:
            return SESSION_REDUCED_S
        return SESSION_NORMAL_S

    async def _tick_once(self) -> None:
        now_wall = time.time()
        now_mono = time.monotonic()
        gap = now_wall - self.last_wall
        delta_mono = max(0.0, now_mono - self.last_mono)

        # 1) Wanduhr-Sprung > 30 s: Das Gerät war im Suspend (der Prozess war
        #    eingefroren, ein Tick hat die Schlafzeit nicht gesehen).
        if gap > MANUAL_SUSPEND_GAP_S:
            self.suspend_pending = False
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
            elapsed = now_wall - self.break_start_wall
            if elapsed >= BREAK_S:
                # Pause vorüber: neue (evtl. verkürzte) Sitzung beginnen.
                limit = self._current_limit_s()
                self.state = STATE_PLAYING if self.game_running else STATE_IDLE
                self.session_s = 0.0
                self.warned = False
                self.suspend_pending = False
                self.break_toast_shown = False
                await decky.emit('break_over', int(limit // 60))
            else:
                self.awake_s += delta_mono
                if self.awake_s >= TOAST_AFTER_WAKE_S and not self.break_toast_shown:
                    # Nur kurz wach lassen, damit der Toast lesbar ist.
                    self.break_toast_shown = True
                    remaining_min = max(1, math.ceil((BREAK_S - elapsed) / 60))
                    await decky.emit('show_break_toast', remaining_min)
                if (self.awake_s >= TOAST_AFTER_WAKE_S + RESUSPEND_AFTER_TOAST_S
                        and not self.suspend_pending):
                    # Erneut in den Ruhemodus, bis die Pause um ist.
                    self.suspend_pending = True
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
                if (not self.warned
                        and (self.session_s >= limit - WARN_BEFORE_S
                             or (total_before < DAILY_LIMIT_S
                                 and (DAILY_LIMIT_S - self.total_today_s) <= WARN_BEFORE_S))):
                    # Vorankündigung: kurz vor Sitzungsende oder kurz davor,
                    # dass kumulativ die 2-Stunden-Marke des Tages erreicht wird.
                    self.warned = True
                    await decky.emit('show_warning')
                if (self.session_s >= limit
                        or (total_before < DAILY_LIMIT_S
                            and self.total_today_s >= DAILY_LIMIT_S)):
                    # Sitzungsende — auch mitten in der Sitzung, wenn kumulativ die
                    # 2-Stunden-Marke des Tages erreicht wird. Danach sind neue
                    # Sitzungen des Tages auf SESSION_REDUCED_S verkürzt; das
                    # Tageslimit selbst beendet nur die Sitzung, die es überschreitet.
                    self.state = STATE_BREAKING
                    self.break_start_wall = now_wall
                    self.awake_s = 0.0
                    self.break_toast_shown = False
                    self.suspend_pending = True
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

    async def set_enabled(self, enabled: bool) -> None:
        """Plugin aktivieren/deaktivieren (wird persistiert)."""
        self.enabled = bool(enabled)
        decky.logger.info('ScreenTime: Aktiv=%s.', self.enabled)
        # Aktivierungs-Änderung sofort sichern, nicht erst nach dem Debounce.
        now_wall = time.time()
        self._persist_state(now_wall)
        self._last_persist_wall = now_wall

    async def get_state(self) -> Dict[str, Any]:
        """Aktueller Status für das QAM-Panel (wird alle 2 s gepollt)."""
        limit = self._current_limit_s()
        now_wall = time.time()
        if self.state == STATE_PLAYING:
            session_remaining_s = max(0.0, limit - self.session_s)
        else:
            session_remaining_s = 0.0
        if self.state == STATE_BREAKING:
            break_remaining_s = max(0.0, BREAK_S - (now_wall - self.break_start_wall))
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
        }