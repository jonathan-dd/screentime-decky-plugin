import { Button, ButtonItem, Focusable, gamepadTabbedPageClasses, PanelSection, PanelSectionRow, SliderField, Tabs, TextField, ToggleField, staticClasses } from "@decky/ui";
import { addEventListener, callable, definePlugin, removeEventListener, toaster } from "@decky/api";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { IconType } from "react-icons";
import { FaCalendarDay, FaClock, FaGamepad, FaLock, FaPowerOff, FaSlidersH } from "react-icons/fa";

import { SteamUtils } from "./utils/steam";
import { STATUS_COLORS, StatusCard } from "./components/StatusCard";
import type { StatusVisual } from "./components/StatusCard";

// SteamClient wird vom Steam-Client als globale Variable bereitgestellt und
// ist über @decky/ui global deklariert (GameSessions/Apps-APIs).

// --- IPC zum Python-Backend ---
const setGameRunningCall = callable<[is_running: boolean], void>("set_game_running");
const setEnabledCall = callable<[enabled: boolean], boolean>("set_enabled");
const getStateCall = callable<[], ScreenTimeState>("get_state");
const pinStatusCall = callable<[], PinStatus>("pin_status");
const setupPinCall = callable<[pin: string], boolean>("setup_pin");
const unlockCall = callable<[pin: string], boolean>("unlock");
const lockCall = callable<[], void>("lock");
const setPinCall = callable<[current_pin: string, new_pin: string], boolean>("set_pin");
const getSettingsCall = callable<[], ScreenTimeSettings>("get_settings");
const setSettingsCall = callable<[settings: ScreenTimeSettings], Record<string, number>>("set_settings");
// v1.4: PIN-Schutz ist abschaltbar (pin_enabled im Backend).
const getPinProtectionCall = callable<[], PinProtectionState>("get_pin_protection");
export interface HistoryEntry {
    date: string;
    day_label: string;
    minutes: number;
}
interface HistoryResponse { days: HistoryEntry[]; }
const getHistoryCall = callable<[], HistoryResponse>("get_history");
const setPinProtectionCall = callable<[enabled: boolean, pin?: string], PinProtectionResult>("set_pin_protection");

// Status, wie ihn das Backend über get_state() liefert
interface ScreenTimeState {
    enabled: boolean;
    state: "idle" | "playing" | "breaking";
    game_running: boolean;
    session_remaining_s: number;
    break_remaining_s: number;
    total_play_min_today: number;
    limit_min: number;
    pin_configured: boolean;
    pin_unlocked: boolean;
}

// Einstellbare Werte (Minuten; warn in Sekunden). Ranges/Clamp macht das Backend.
interface ScreenTimeSettings {
    session_minutes: number;
    break_minutes: number;
    daily_limit_minutes: number;
    reduced_session_minutes: number;
    warn_before_seconds: number;
}

// PIN-Zustand aus pin_status() — 'enabled' = effektiver Schutz (v1.4).
interface PinStatus {
    configured: boolean;
    enabled: boolean;
    unlocked: boolean;
    lockout_remaining_s: number;
}

// PIN-Schutz-Zustand aus get_pin_protection() (v1.4).
interface PinProtectionState {
    enabled: boolean;
    pin_set: boolean;
    unlocked: boolean;
}

// Antwort von set_pin_protection() (v1.4): error 'locked' => Erst entsperren,
// 'pin_required'/'invalid_pin' => beim Aktivieren ohne gültige PIN.
interface PinProtectionResult {
    success: boolean;
    error?: string;
}

// Sekunden als mm:ss formatieren
const formatMMSS = (seconds: number): string => {
    const s = Math.max(0, Math.floor(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// Minuten als "Xh YYm" (volle Stunden: "Xh"; unter 1 h: "Ym")
const formatHM = (minutes: number): string => {
    const m = Math.max(0, Math.floor(minutes));
    const h = Math.floor(m / 60);
    const rest = m % 60;
    if (h <= 0) return `${rest}m`;
    return rest > 0 ? `${h}h ${String(rest).padStart(2, "0")}m` : `${h}h`;
};

const hintStyle: CSSProperties = {
    fontSize: "12px",
    color: "#aaaaaa",
    lineHeight: 1.4,
};

const errorStyle: CSSProperties = {
    fontSize: "12px",
    color: "#ff6b6b",
    lineHeight: 1.4,
};

const buttonRowStyle: CSSProperties = {
    display: "flex",
    gap: "8px",
    width: "100%",
    marginTop: "4px",
};

const sectionHeaderStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "10px 2px 4px",
};

const sectionHeaderTextStyle: CSSProperties = {
    fontSize: "13px",
    fontWeight: 600,
    letterSpacing: "0.5px",
    textTransform: "uppercase",
    color: "#8f98a0",
};

// Tab-Icons (Armada-Control-Muster): block-Layout, damit sie im
// Steam-Tab-Raster sauber sitzen.
// Fix für vertikal abgeschnittenen Tab-Content im QAM (Muster Armada Control):
// Explizite Höhenkette Wrapper -> Tabs-Root -> TabContentsScroll, sonst kollabiert
// der Scroll-Bereich und Content wird am unteren Rand abgeschnitten.
const { TabContents, TabContentsScroll } = gamepadTabbedPageClasses;
const tabStyles = `
      .screentime-tabs {
        width: 100%;
        height: 95vh;
        min-width: 0;
        min-height: 0;
      }
      .screentime-tabs > div {
        height: 100%;
        min-height: 0;
      }
      .screentime-tabs .${TabContents},
      .screentime-tabs .${TabContentsScroll} {
        min-width: 0;
        min-height: 0;
      }
      .screentime-tabs .${TabContentsScroll} {
        padding-left: 0;
        padding-right: 0;
      }
      .screentime-tabs [role="tablist"] {
        display: flex;
        flex-wrap: nowrap;
        justify-content: center;
      }
      .screentime-tabs [role="tab"] {
        flex: 0 1 auto;
        min-width: 0;
        box-sizing: border-box;
        padding-left: 6px;
        padding-right: 6px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .screentime-tabs [role="tab"] svg {
        display: block;
        margin: 0;
      }
      .screentime-tab-content {
        padding-bottom: 24px;
      }
`;

const accentButtonStyle: CSSProperties = {
    color: '#ffffff',
    background: 'rgba(78, 161, 255, 0.35)',
    border: '1px solid rgba(78, 161, 255, 0.7)',
    borderRadius: '40px',
};

const tabIconStyle: CSSProperties = {
    display: "block",
    margin: "0 auto",
};

interface SectionHeaderProps {
    icon: IconType;
    children: ReactNode;
}

// Abschnitts-Header im Stil der Steam-Gruppenbeschriftungen: Icon + Text,
// dezent grau — trennt Status/PIN/Einstellungen im schmalen QAM-Panel.
const SectionHeader = ({ icon: Icon, children }: SectionHeaderProps) => (
    <PanelSectionRow>
        <div style={sectionHeaderStyle}>
            <Icon size={14} style={{ color: "#8f98a0", flexShrink: 0 }} />
            <span style={sectionHeaderTextStyle}>{children}</span>
        </div>
    </PanelSectionRow>
);

// PIN-Länge (muss zum Backend passen: 4–8 Zeichen)
const PIN_MIN = 4;
const PIN_MAX = 8;

const pinLengthOk = (pin: string): boolean =>
    pin.length >= PIN_MIN && pin.length <= PIN_MAX;

function Content() {
    // Aktiver Tab (Steam rendert die Tab-Leiste + LB/RB-Wechsel selbst).
    const [tab, setTab] = useState("Status");

    // Letzter Poll-Stand: Backend-Antwort + Poll-Zeitpunkt. Die Countdown-
    // Anzeige interpoliert daraus lokal weiter; der 2-s-Poll korrigiert Drift.
    const [poll, setPoll] = useState<{ s: ScreenTimeState; at: number } | null>(null);
    // PIN-Zustand aus demselben 2-s-Zyklus (Lockout-Anzeige + Schutz-Flag).
    const [pinStatus, setPinStatus] = useState<PinStatus | null>(null);
    // 250-ms-Tick treibt die lokale Anzeige zwischen den 2-s-Polls an.
    const [nowTick, setNowTick] = useState<number>(() => Date.now());

    // Einstellungen (Slider-Werte, optimistisch; Backend bestätigt/clampt).
    const [settings, setSettings] = useState<ScreenTimeSettings | null>(null);
    const settingsRef = useRef<ScreenTimeSettings | null>(null);
    const settingsTimer = useRef<number | undefined>(undefined);

    // PIN-Eingaben ( Setup / Unlock / Ändern )
    const [setupPin, setSetupPin] = useState("");
    const [setupPinConfirm, setSetupPinConfirm] = useState("");
    const [unlockPin, setUnlockPin] = useState("");
    const [changeOpen, setChangeOpen] = useState(false);
    const [changeCur, setChangeCur] = useState("");
    const [changeNew, setChangeNew] = useState("");
    const [changeNewConfirm, setChangeNewConfirm] = useState("");
    const [pinError, setPinError] = useState<string | null>(null);
    // Inline-Setup nach 'PIN-Schutz' aktivieren ohne vorhandene PIN.
    const [protectionSetupOpen, setProtectionSetupOpen] = useState(false);

    // Verlauf (7 Tage): geladen initial + bei Tab-Wechsel + 60-s-Refresh.
    const [history, setHistory] = useState<HistoryEntry[] | null>(null);
    const [activeTab, setActiveTab] = useState('Status');
    const doLoadHistory = useCallback(async () => {
        try {
            const res = await getHistoryCall();
            setHistory(res.days ?? []);
        } catch {
            setHistory(null);
        }
    }, []);

    // Anzeige lokal im 250-ms-Interval weiterlaufen lassen, statt nur
    // sprunghaft mit jedem 2-s-Poll zu aktualisieren.
    useEffect(() => {
        const timer = setInterval(() => setNowTick(Date.now()), 250);
        return () => clearInterval(timer);
    }, []);

    // Verlauf: initial laden und aktualisieren, wenn der Verlauf-Tab offen ist
    // (oder das Panel frisch gemountet wurde); alle 60 s im Hintergrund frischhalten.
    useEffect(() => {
        void doLoadHistory();
        if (activeTab !== 'Verlauf') return;
        const t = setInterval(() => void doLoadHistory(), 60_000);
        return () => clearInterval(t);
    }, [activeTab, doLoadHistory]);

    // Status alle 2 s pollen, solange das Panel geöffnet ist (Synchronisation).
    useEffect(() => {
        let mounted = true;
        let lastState: ScreenTimeState["state"] | undefined;
        const pollState = async (): Promise<void> => {
            try {
                const s = await getStateCall();
                if (!mounted || !s) return;
                const prevState = lastState;
                lastState = s.state;
                setPoll({ s, at: Date.now() });
                if (prevState !== undefined && s.state !== prevState) {
                    // Zustandswechsel erkannt: sofort nochmal pollen für frische
                    // Restzeiten, statt auf den nächsten 2-s-Tick zu warten.
                    void pollState();
                }
            } catch (e) {
                console.error("ScreenTime: Statusabfrage fehlgeschlagen.", e);
            }
            try {
                const ps = await pinStatusCall();
                if (mounted && ps) setPinStatus(ps);
            } catch {
                /* pin_status ist optional für die Anzeige */
            }
        };
        void pollState();
        const interval = setInterval(() => {
            void pollState();
        }, 2000);
        return () => {
            mounted = false;
            clearInterval(interval);
        };
    }, []);

    const status = poll?.s ?? null;
    const pinConfigured = status?.pin_configured ?? false;
    const unlocked = status?.pin_unlocked ?? false;
    const protectionOn = pinStatus?.enabled ?? false;
    const pinLockoutS = pinStatus?.lockout_remaining_s ?? 0;

    // PIN-Gate: Schutz an und nicht entsperrt => statt der Settings nur das
    // Gate (Entsperren bzw. Defensive: Setup-Formular ohne PIN). Bei Schutz
    // aus oder entsperrt sind alle Einstellungen frei editierbar.
    const gateActive = protectionOn && !unlocked;

    // Einstellungen laden, sobald sie sichtbar sein können (get_settings ist
    // offen/lesend — auch bei angezogenem Gate darf gelesen werden).
    useEffect(() => {
        if (gateActive || settingsRef.current) return;
        void getSettingsCall()
            .then((s) => {
                if (s) {
                    setSettings(s);
                    settingsRef.current = s;
                }
            })
            .catch((e) => console.error("ScreenTime: Einstellungen nicht lesbar.", e));
    }, [gateActive]);

    // Debounced Slider-Batch: alle 400 ms nach der letzten Änderung senden;
    // akzeptierte (geclampte) Werte inline zurückspiegeln. Fehler (z. B.
    // zwischenzeitlich gesperrt) => der 2-s-Poll zieht das Panel zurück
    // in den Sperr-Zustand.
    const scheduleSettingsSend = () => {
        if (settingsTimer.current !== undefined) {
            window.clearTimeout(settingsTimer.current);
        }
        settingsTimer.current = window.setTimeout(() => {
            settingsTimer.current = undefined;
            const current = settingsRef.current;
            if (!current) return;
            void setSettingsCall(current)
                .then((accepted) => {
                    if (accepted && Object.keys(accepted).length === 5) {
                        const fixed = accepted as unknown as ScreenTimeSettings;
                        settingsRef.current = fixed;
                        setSettings(fixed);
                    }
                })
                .catch((e) => console.error("ScreenTime: Einstellungen nicht gespeichert.", e));
        }, 400);
    };

    useEffect(() => () => {
        if (settingsTimer.current !== undefined) window.clearTimeout(settingsTimer.current);
    }, []);

    const onSettingChange = (key: keyof ScreenTimeSettings, value: number) => {
        setSettings((prev) => {
            if (!prev) return prev;
            const next = { ...prev, [key]: value };
            settingsRef.current = next;
            return next;
        });
        scheduleSettingsSend();
    };

    // --- PIN-Aktionen ---

    const doSetupPin = async () => {
        if (!pinLengthOk(setupPin) || setupPin !== setupPinConfirm) return;
        const ok = await setupPinCall(setupPin);
        setSetupPin("");
        setSetupPinConfirm("");
        if (ok) {
            // setup_pin aktiviert den Schutz sofort (v1.3.x-Semantik); der
            // nächste Poll zieht das Panel ins Gate.
            setProtectionSetupOpen(false);
            setPinError(null);
            refreshPinProtection();
        } else {
            setPinError("PIN konnte nicht festgelegt werden.");
        }
    };

    const doUnlock = async () => {
        const ok = await unlockCall(unlockPin);
        setUnlockPin("");
        if (ok) {
            setPinError(null);
        } else {
            setPinError(
                pinLockoutS > 0
                    ? `Zu viele Fehlversuche — gesperrt (${Math.ceil(pinLockoutS)} s)`
                    : "Falsche PIN.",
            );
        }
    };

    const doChangePin = async () => {
        if (!pinLengthOk(changeNew) || changeNew !== changeNewConfirm) return;
        // Bei ausgeschaltetem Schutz kann das Unlock-Fenster zu sein — set_pin
        // braucht es aber (unverändert). Dann erst mit der aktuellen PIN
        // entsperren; scheitert das, war sie falsch.
        if (!unlocked) {
            const okUnlock = await unlockCall(changeCur);
            if (!okUnlock) {
                setPinError(
                    pinLockoutS > 0
                        ? `Zu viele Fehlversuche — gesperrt (${Math.ceil(pinLockoutS)} s)`
                        : "Falsche PIN.",
                );
                return;
            }
        }
        const ok = await setPinCall(changeCur, changeNew);
        if (ok) {
            setChangeOpen(false);
            setChangeCur("");
            setChangeNew("");
            setChangeNewConfirm("");
            setPinError(null);
        } else {
            setPinError("Ändern fehlgeschlagen — aktuelle PIN falsch?");
        }
    };

    const doLock = () => {
        setChangeOpen(false);
        setChangeCur("");
        setChangeNew("");
        setChangeNewConfirm("");
        setUnlockPin("");
        setPinError(null);
        void lockCall();
    };

    // Sofortiger Schutz-Refresh nach PIN-Aktionen (der 2-s-Poll zieht
    // spätestens ebenfalls nach).
    const refreshPinProtection = () => {
        void getPinProtectionCall()
            .then((p) => {
                if (!p) return;
                setPinStatus((prev) => ({
                    configured: p.pin_set,
                    enabled: p.enabled,
                    unlocked: p.unlocked,
                    lockout_remaining_s: prev?.lockout_remaining_s ?? 0,
                }));
            })
            .catch(() => {
                /* Pin-Status kommt über den 2-s-Poll nach */
            });
    };

    const doEnableProtection = async () => {
        // Ohne vorhandene PIN: Inline-Setup anzeigen (setup_pin schreibt Hash
        // und aktiviert den Schutz in einem Rutsch — v1.3.x-Semantik).
        if (!pinConfigured) {
            setProtectionSetupOpen(true);
            return;
        }
        const res = await setPinProtectionCall(true);
        if (res?.success) {
            setPinError(null);
        } else {
            setPinError("Schutz konnte nicht aktiviert werden.");
        }
        refreshPinProtection();
    };

    const doDisableProtection = async () => {
        const res = await setPinProtectionCall(false);
        if (res?.success) {
            setPinError(null);
        } else {
            // 'locked' => Unlock-Fenster abgelaufen: erst entsperren.
            setPinError(res?.error === "locked" ? "Erst entsperren." : "Schutz konnte nicht deaktiviert werden.");
        }
        refreshPinProtection();
    };

    const onProtectionToggle = (checked: boolean) => {
        if (checked) {
            void doEnableProtection();
        } else {
            setProtectionSetupOpen(false);
            if (pinConfigured) void doDisableProtection();
        }
    };

    // Restzeit (Session/Pause) lokal dekrementieren: seit dem Poll verstrichene
    // Zeit abziehen, auf 0 geklemmt — Drift korrigiert der nächste Poll.
    let countdown: number | null = null;
    if (poll && status && (status.state === "playing" || status.state === "breaking")) {
        const polled = status.state === "playing"
            ? status.session_remaining_s
            : status.break_remaining_s;
        const elapsed = Math.max(0, (nowTick - poll.at) / 1000);
        countdown = Math.max(0, polled - elapsed);
    }

    // Gesamt-Länge der aktuellen Phase für den Fortschrittsbalken: Session-
    // Grenze direkt aus dem Backend (limit_min = aktuelle Session-Länge in
    // Minuten), Pausen-Länge als Maximum der gesehenen Restzeiten (die
    // Einstellungen sind im gesperrten Zustand evtl. nicht geladen).
    // Beim Verlassen des Zustands wird zurückgesetzt. Beides ist idempotent
    // und darf daher im Render laufen.
    const sessionTotalS = useRef(0);
    const breakTotalS = useRef(0);
    if (poll) {
        if (poll.s.state === "playing") {
            sessionTotalS.current = Math.max(
                sessionTotalS.current,
                poll.s.session_remaining_s,
                poll.s.limit_min * 60,
            );
        } else {
            sessionTotalS.current = 0;
        }
        if (poll.s.state === "breaking") {
            breakTotalS.current = Math.max(
                breakTotalS.current,
                poll.s.break_remaining_s,
                settings ? settings.break_minutes * 60 : 0,
            );
        } else {
            breakTotalS.current = 0;
        }
    }

    // Balken-Fortschritt: playing = verstrichene Session, breaking =
    // Pausen-Fortschritt; läuft über die Countdown-Interpolation mit.
    let progress: number | null = null;
    if (countdown !== null && status) {
        if (status.state === "playing" && sessionTotalS.current > 0) {
            progress = Math.min(1, Math.max(0, 1 - countdown / sessionTotalS.current));
        } else if (status.state === "breaking" && breakTotalS.current > 0) {
            progress = Math.min(1, Math.max(0, 1 - countdown / breakTotalS.current));
        }
    }

    // Statuszeile: farbiger Punkt + Label (grün = Spielzeit, blau = bereit,
    // grau = aus/lädt, orange = erzwungene Pause).
    const statusVisual: StatusVisual = !status
        ? { color: STATUS_COLORS.off, label: "Lade …" }
        : !status.enabled
            ? { color: STATUS_COLORS.off, label: "Aus" }
            : status.state === "playing"
                ? { color: STATUS_COLORS.playing, label: "Spielzeit läuft" }
                : status.state === "breaking"
                    ? { color: STATUS_COLORS.breaking, label: "Erzwungene Pause" }
                    : { color: STATUS_COLORS.ready, label: "Bereit (kein Spiel)" };

    const countdownText = countdown !== null ? formatMMSS(countdown) : null;

    // „Heute gespielt": eigene Label-Wert-Zeile; mit geladenen Einstellungen
    // zusätzlich das Tageslimit als Referenz.
    const todayText = !status
        ? "…"
        : `${formatHM(status.total_play_min_today)}${
              settings ? ` von ${formatHM(settings.daily_limit_minutes)}` : ""
          }`;

    const setupPinInvalid =
        setupPin.length > 0 && (!pinLengthOk(setupPin) || setupPin !== setupPinConfirm);
    const changeNewInvalid =
        changeNew.length > 0 && (!pinLengthOk(changeNew) || changeNew !== changeNewConfirm);

    // Setup-Formular (Inline nach 'PIN-Schutz aktivieren' ohne PIN; defensiv
    // auch im Gate, falls der Schutz an ist aber keine PIN existiert).
    // Bewusst eine Funktion statt einer Komponente: Die Felder bleiben
    // direkt im Baum der Eltern-Instanz (kein Remount bei jedem Render).
    const renderSetupForm = (hint: string) => (
        <>
            <PanelSectionRow>
                <div style={hintStyle}>{hint}</div>
            </PanelSectionRow>
            <PanelSectionRow>
                <TextField
                    label="PIN (4–8 Zeichen)"
                    value={setupPin}
                    bIsPassword
                    focusOnMount
                    onChange={(e) => setSetupPin(e.target.value)}
                />
            </PanelSectionRow>
            <PanelSectionRow>
                <TextField
                    label="PIN wiederholen"
                    value={setupPinConfirm}
                    bIsPassword
                    onChange={(e) => setSetupPinConfirm(e.target.value)}
                />
            </PanelSectionRow>
            {setupPinInvalid && (
                <PanelSectionRow>
                    <div style={errorStyle}>PIN muss 4–8 Zeichen lang sein und übereinstimmen.</div>
                </PanelSectionRow>
            )}
            {pinError && (
                <PanelSectionRow>
                    <div style={errorStyle}>{pinError}</div>
                </PanelSectionRow>
            )}
            <PanelSectionRow>
                <ButtonItem
                    layout="below"
                    onClick={() => void doSetupPin()}
                    disabled={!pinLengthOk(setupPin) || setupPin !== setupPinConfirm}
                >
                    PIN festlegen
                </ButtonItem>
            </PanelSectionRow>
        </>
    );

    // --- Tab 'Status': komplett READ-ONLY (auch bei PIN-Schutz sichtbar) ---
    const statusTab = (
    <div className="screentime-tab-content">
        <PanelSection>
            <PanelSectionRow>
                <StatusCard
                    visual={statusVisual}
                    countdown={countdownText}
                    progress={progress}
                    todayText={todayText}
                />
            </PanelSectionRow>
        </PanelSection>
    </div>
    );

    // --- Tab 'Verlauf': Spielzeit der letzten 7 Tage (Mo..So, ältester zuerst) ---
    const fmtMin = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`);

    const dayBarRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', minWidth: 0 };
    const dayBarLabelStyle: CSSProperties = { width: 34, flexShrink: 0, opacity: 0.8, fontSize: 13 };
    const dayBarTrackStyle: CSSProperties = { flex: 1, minWidth: 0, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.16)' };
    const dayBarValueStyle: CSSProperties = { width: 62, flexShrink: 0, textAlign: 'right', fontSize: 12, opacity: 0.85, fontVariantNumeric: 'tabular-nums' };

    const maxHistoryMin = Math.max(
        settings?.daily_limit_minutes ?? 0,
        ...(history ?? []).map((d) => d.minutes),
        1,
    );

    const historyTab = (
    <div className="screentime-tab-content">
        <PanelSection>
            <SectionHeader icon={FaCalendarDay}>Letzte 7 Tage</SectionHeader>
            {history === null ? (
                <PanelSectionRow>
                    <div style={hintStyle}>Lade Verlauf …</div>
                </PanelSectionRow>
            ) : (
                history.map((d) => (
                    <PanelSectionRow key={d.date}>
                        <div style={dayBarRowStyle}>
                            <div style={dayBarLabelStyle}>{d.day_label || d.date.slice(5)}</div>
                            <div style={dayBarTrackStyle}>
                                <div style={{
                                    height: '100%',
                                    width: `${Math.min(100, (d.minutes / maxHistoryMin) * 100)}%`,
                                    borderRadius: 3,
                                    background: d.date === history[history.length - 1]?.date
                                        ? '#4ea1ff'
                                        : 'rgba(78,161,255,0.55)',
                                    transition: 'width 250ms linear',
                                }} />
                            </div>
                            <div style={dayBarValueStyle}>{fmtMin(d.minutes)}</div>
                        </div>
                    </PanelSectionRow>
                ))
            )}
            {settings?.daily_limit_minutes ? (
                <PanelSectionRow>
                    <div style={hintStyle}>{`Balken skaliert auf ${fmtMin(settings.daily_limit_minutes)} (Tageslimit).`}</div>
                </PanelSectionRow>
            ) : null}
        </PanelSection>
    </div>
    );

    // --- Tab 'Einstellungen': der komplette interaktive Bereich ---
    const settingsTab = (
    <div className="screentime-tab-content">
        <PanelSection>
            {/* PIN-Gate: Schutz an + nicht entsperrt => KEINE Settings hier. */}
            {status !== null && gateActive && (
                <>
                    <SectionHeader icon={FaLock}>PIN</SectionHeader>
                    {pinConfigured ? (
                        <>
                            <PanelSectionRow>
                                <div style={hintStyle}>Gesperrt — zum Ändern von Einstellungen entsperren:</div>
                            </PanelSectionRow>
                            <PanelSectionRow>
                                <TextField
                                    label="PIN"
                                    value={unlockPin}
                                    bIsPassword
                                    focusOnMount
                                    onChange={(e) => setUnlockPin(e.target.value)}
                                />
                            </PanelSectionRow>
                            {pinError && (
                                <PanelSectionRow>
                                    <div style={errorStyle}>{pinError}</div>
                                </PanelSectionRow>
                            )}
                            {pinLockoutS > 0 && (
                                <PanelSectionRow>
                                    <div style={errorStyle}>{`Zu viele Fehlversuche — entsperrt in ${Math.ceil(pinLockoutS)} s`}</div>
                                </PanelSectionRow>
                            )}
                            <PanelSectionRow>
                                <Button
                                    style={{
                                        ...accentButtonStyle,
                                        width: '100%',
                                        height: '40px',
                                        fontSize: '15px',
                                        fontWeight: 600,
                                    }}
                                    onClick={() => void doUnlock()}
                                    disabled={unlockPin.length < PIN_MIN || pinLockoutS > 0}
                                >
                                    Entsperren
                                </Button>
                            </PanelSectionRow>
                        </>
                    ) : (
                        renderSetupForm("Kein PIN gesetzt — Einstellungen sind ungeschützt. Jetzt PIN festlegen:")
                    )}
                </>
            )}

            {/* Entsperrt oder Schutz aus: Settings + PIN-Sektion. */}
            {status !== null && !gateActive && settings !== null && (
                <>
                    <PanelSectionRow>
                        <ToggleField
                            icon={<FaPowerOff />}
                            label="Aktiv"
                            checked={status.enabled}
                            onChange={(checked: boolean) => {
                                // Optimistisch umschalten; bei Ablehnung (z. B.
                                // zwischenzeitlich gesperrt) korrigiert der Poll.
                                setPoll((p) => (p ? { ...p, s: { ...p.s, enabled: checked } } : p));
                                void setEnabledCall(checked);
                            }}
                        />
                    </PanelSectionRow>
                    <PanelSectionRow>
                        <SliderField
                            label="Session-Länge"
                            value={settings.session_minutes}
                            min={5}
                            max={180}
                            step={5}
                            showValue
                            valueSuffix=" Min."
                            onChange={(v: number) => onSettingChange("session_minutes", v)}
                        />
                    </PanelSectionRow>
                    <PanelSectionRow>
                        <SliderField
                            label="Pausenlänge"
                            value={settings.break_minutes}
                            min={5}
                            max={120}
                            step={1}
                            showValue
                            valueSuffix=" Min."
                            onChange={(v: number) => onSettingChange("break_minutes", v)}
                        />
                    </PanelSectionRow>
                    <SectionHeader icon={FaCalendarDay}>Limit &amp; Vorwarnung</SectionHeader>
                    <PanelSectionRow>
                        <SliderField
                            label="Tageslimit"
                            value={settings.daily_limit_minutes}
                            min={30}
                            max={720}
                            step={15}
                            showValue
                            valueSuffix=" Min."
                            onChange={(v: number) => onSettingChange("daily_limit_minutes", v)}
                        />
                    </PanelSectionRow>
                    <PanelSectionRow>
                        <SliderField
                            label="Session nach Limit"
                            value={settings.reduced_session_minutes}
                            min={1}
                            max={60}
                            step={1}
                            showValue
                            valueSuffix=" Min."
                            onChange={(v: number) => onSettingChange("reduced_session_minutes", v)}
                        />
                    </PanelSectionRow>
                    <PanelSectionRow>
                        <SliderField
                            label="Warn-Vorlauf"
                            value={settings.warn_before_seconds}
                            min={15}
                            max={300}
                            step={15}
                            showValue
                            valueSuffix=" s"
                            onChange={(v: number) => onSettingChange("warn_before_seconds", v)}
                        />
                    </PanelSectionRow>

                    {/* --- PIN-Sektion (v1.4: Schutz hier abschaltbar) --- */}
                    {!changeOpen ? (
                        <>
                            <SectionHeader icon={FaLock}>PIN</SectionHeader>
                            {pinConfigured && (
                                <PanelSectionRow>
                                    <Focusable style={buttonRowStyle} flow-children="horizontal">
                                        <Button style={{ ...accentButtonStyle, flex: 1, height: '36px', fontSize: '14px', fontWeight: 600 }} onClick={() => setChangeOpen(true)}>PIN ändern</Button>
                                        <Button style={{ ...accentButtonStyle, flex: 1, height: '36px', fontSize: '14px', fontWeight: 600 }} onClick={doLock}>Jetzt sperren</Button>
                                    </Focusable>
                                </PanelSectionRow>
                            )}
                            <PanelSectionRow>
                                <ToggleField
                                    icon={<FaLock />}
                                    label="PIN-Schutz"
                                    checked={protectionOn || protectionSetupOpen}
                                    onChange={onProtectionToggle}
                                />
                            </PanelSectionRow>
                            {!pinConfigured && !protectionSetupOpen && (
                                <PanelSectionRow>
                                    <div style={hintStyle}>Kein PIN gesetzt — Einstellungen sind ungeschützt.</div>
                                </PanelSectionRow>
                            )}
                            {protectionSetupOpen &&
                                renderSetupForm("PIN festlegen, um Einstellungen und Aktiv-Schalter zu schützen:")}
                            {!protectionSetupOpen && pinError && (
                                <PanelSectionRow>
                                    <div style={errorStyle}>{pinError}</div>
                                </PanelSectionRow>
                            )}
                        </>
                    ) : (
                        <>
                            <SectionHeader icon={FaLock}>PIN</SectionHeader>
                            <PanelSectionRow>
                                <TextField
                                    label="Aktuelle PIN"
                                    value={changeCur}
                                    bIsPassword
                                    focusOnMount
                                    onChange={(e) => setChangeCur(e.target.value)}
                                />
                            </PanelSectionRow>
                            <PanelSectionRow>
                                <TextField
                                    label="Neue PIN"
                                    value={changeNew}
                                    bIsPassword
                                    onChange={(e) => setChangeNew(e.target.value)}
                                />
                            </PanelSectionRow>
                            <PanelSectionRow>
                                <TextField
                                    label="Neue PIN wiederholen"
                                    value={changeNewConfirm}
                                    bIsPassword
                                    onChange={(e) => setChangeNewConfirm(e.target.value)}
                                />
                            </PanelSectionRow>
                            {changeNewInvalid && (
                                <PanelSectionRow>
                                    <div style={errorStyle}>Neue PIN muss 4–8 Zeichen lang sein und übereinstimmen.</div>
                                </PanelSectionRow>
                            )}
                            {pinError && (
                                <PanelSectionRow>
                                    <div style={errorStyle}>{pinError}</div>
                                </PanelSectionRow>
                            )}
                            <PanelSectionRow>
                                <Focusable style={buttonRowStyle} flow-children="horizontal">
                                    <Button
                                        onClick={() => void doChangePin()}
                                        disabled={!pinLengthOk(changeNew) || changeNew !== changeNewConfirm || changeCur.length < PIN_MIN}
                                        style={{ ...accentButtonStyle, flex: 1, height: '36px', fontSize: '14px', fontWeight: 600 }}
                                    >
                                        PIN speichern
                                    </Button>
                                    <Button
                                        style={{ flex: 1, height: '36px', fontSize: '14px' }}
                                        onClick={() => {
                                            setChangeOpen(false);
                                            setChangeCur("");
                                            setChangeNew("");
                                            setChangeNewConfirm("");
                                            setPinError(null);
                                        }}
                                    >
                                        Abbrechen
                                    </Button>
                                </Focusable>
                            </PanelSectionRow>
                        </>
                    )}
                </>
            )}
        </PanelSection>
    </div>
    );

    return (
        <div className="screentime-tabs">
        <style>{tabStyles}</style>
        <Tabs
            activeTab={tab}
            onShowTab={(shown: string) => { setTab(shown); setActiveTab(shown); }}
            tabs={[
                {
                    id: "Status",
                    title: <FaGamepad size={18} style={tabIconStyle} />,
                    content: statusTab,
                },
                {
                    id: "Verlauf",
                    title: <FaCalendarDay size={18} style={tabIconStyle} />,
                    content: historyTab,
                },
                {
                    id: "Einstellungen",
                    title: <FaSlidersH size={18} style={tabIconStyle} />,
                    content: settingsTab,
                },
            ]}
        />
        </div>
    );
}

export default definePlugin(() => {
    // --- Backend-Events ---
    // Wichtig: Die Listener werden im Körper der definePlugin-Factory
    // registriert (läuft einmal beim Plugin-Load), NICHT in einer
    // React-Komponente — sonst gäbe es sie nur, solange das QAM-Panel offen ist.

    const onShowWarning = () => {
        toaster.toast({
            title: "ScreenTime",
            body: "Noch 1 Minute Spielzeit — danach wird das Gerät in den Ruhemodus versetzt.",
        });
    };

    const onShowBreakToast = (min: number) => {
        toaster.toast({ title: "ScreenTime", body: `Noch ${min} Minuten Pause verbleibend` });
    };

    const onBreakOver = (limitMin: number) => {
        toaster.toast({ title: "ScreenTime", body: `Pause beendet — wieder ${limitMin} Minuten Spielzeit.` });
    };

    const onSuspendGaveUp = (attempts: number) => {
        toaster.toast({
            title: "ScreenTime",
            body: `Suspend nach ${attempts} Versuchen aufgegeben — die Pause läuft ohne Zwangs-Ruhemodus weiter.`,
        });
    };

    const onSuspendNow = () => {
        // Wie AlarMe: 3 s warten, bis der Steam-UI (Toasts/Events) bereit ist —
        // ein sofortiger Aufruf schlägt sonst still fehl. Wiederholte Emits des
        // Backends (Retry alle 5 s) sind dadurch harmlos, der Aufruf ist idempotent.
        // Der Backend-Tick friert mit ein und erkennt das Aufwachen am Wanduhr-Sprung.
        setTimeout(() => SteamUtils.suspend(), 3000);
    };

    addEventListener("show_warning", onShowWarning);
    addEventListener("show_break_toast", onShowBreakToast);
    addEventListener("break_over", onBreakOver);
    addEventListener("suspend_now", onSuspendNow);
    addEventListener("suspend_gave_up", onSuspendGaveUp);

    // --- Spiel-Erkennung: Steam-App-Starts/Stops verfolgen ---
    // Set-basiertes Tracking laufender App-IDs (Muster aus dem AlarMe-Plugin),
    // damit mehrere gleichzeitig laufende Apps korrekt behandelt werden.
    const runningAppIds = new Set<string>();
    let unregisterGameLifetime: (() => void) | undefined;
    const syncGameRunning = () => {
        void setGameRunningCall(runningAppIds.size > 0);
    };

    try {
        if (
            typeof SteamClient !== "undefined" &&
            SteamClient?.GameSessions?.RegisterForAppLifetimeNotifications
        ) {
            const unregister = SteamClient.GameSessions.RegisterForAppLifetimeNotifications((update) => {
                if (!update?.unAppID) return;
                const appId = String(update.unAppID);
                if (update.bRunning) {
                    // App gestartet
                    runningAppIds.add(appId);
                } else {
                    // App beendet
                    runningAppIds.delete(appId);
                }
                syncGameRunning();
            });
            unregisterGameLifetime = () => unregister.unregister();
        }
    } catch (e) {
        console.error("ScreenTime: Konnte die App-Lifetime-Listener nicht registrieren.", e);
    }

    // Best effort: Läuft beim Plugin-Load bereits ein Spiel? GetRunningApps ist
    // je nach Steam-Version nicht vorhanden — dann still weiterlaufen lassen;
    // der Timer startet dann beim nächsten Steam-App-Event.
    try {
        const runningApps = (SteamClient?.Apps as any)?.GetRunningApps?.();
        const applyRunningApps = (apps: unknown) => {
            if (Array.isArray(apps)) void setGameRunningCall(apps.length > 0);
        };
        if (runningApps?.then) {
            runningApps.then(applyRunningApps).catch(() => {
                /* Best effort — Fehler ignorieren */
            });
        } else {
            applyRunningApps(runningApps);
        }
    } catch {
        /* Best effort — Methode fehlt je nach Steam-Version */
    }

    return {
        name: "ScreenTime",
        titleView: <div className={staticClasses.Title}>ScreenTime</div>,
        content: <Content />,
        icon: <FaClock />,
        onDismount() {
            // Alle hängenden Listener entfernen
            removeEventListener("show_warning", onShowWarning);
            removeEventListener("show_break_toast", onShowBreakToast);
            removeEventListener("break_over", onBreakOver);
            removeEventListener("suspend_now", onSuspendNow);
            removeEventListener("suspend_gave_up", onSuspendGaveUp);
            unregisterGameLifetime?.();
        },
    };
});
