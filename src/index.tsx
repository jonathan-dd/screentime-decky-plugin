import { PanelSection, PanelSectionRow, ToggleField, staticClasses } from "@decky/ui";
import { addEventListener, callable, definePlugin, removeEventListener, toaster } from "@decky/api";
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { FaClock } from "react-icons/fa";

import { SteamUtils } from "./utils/steam";

// SteamClient wird vom Steam-Client als globale Variable bereitgestellt und
// ist über @decky/ui global deklariert (GameSessions/Apps-APIs).

// --- IPC zum Python-Backend ---
const setGameRunningCall = callable<[is_running: boolean], void>("set_game_running");
const setEnabledCall = callable<[enabled: boolean], void>("set_enabled");
const getStateCall = callable<[], ScreenTimeState>("get_state");

// Status, wie ihn das Backend über get_state() liefert
interface ScreenTimeState {
    enabled: boolean;
    state: "idle" | "playing" | "breaking";
    game_running: boolean;
    session_remaining_s: number;
    break_remaining_s: number;
    total_play_min_today: number;
    limit_min: number;
}

// Sekunden als mm:ss formatieren
const formatMMSS = (seconds: number): string => {
    const s = Math.max(0, Math.floor(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const textStyle: CSSProperties = {
    whiteSpace: "pre-wrap",
    fontSize: "14px",
};

function Content() {
    const [status, setStatus] = useState<ScreenTimeState | null>(null);

    // Status alle 2 s pollen, solange das Panel geöffnet ist
    useEffect(() => {
        let mounted = true;
        const poll = async () => {
            try {
                const s = await getStateCall();
                if (mounted && s) setStatus(s);
            } catch (e) {
                console.error("ScreenTime: Statusabfrage fehlgeschlagen.", e);
            }
        };
        void poll();
        const interval = setInterval(() => {
            void poll();
        }, 2000);
        return () => {
            mounted = false;
            clearInterval(interval);
        };
    }, []);

    const statusText = !status
        ? "Status: Lade …"
        : !status.enabled
            ? "Status: Aus"
            : status.state === "playing"
                ? "Status: Spielzeit läuft"
                : status.state === "breaking"
                    ? "Status: Erzwungene Pause"
                    : "Status: Bereit (kein Spiel)";

    return (
        <PanelSection title="ScreenTime">
            <PanelSectionRow>
                {status === null ? (
                    <div style={textStyle}>Status wird geladen …</div>
                ) : (
                    <ToggleField
                        label="Aktiv"
                        checked={status.enabled}
                        onChange={(checked: boolean) => {
                            // Optimistisch umschalten; der 2-Sekunden-Poll gleicht aus.
                            setStatus({ ...status, enabled: checked });
                            void setEnabledCall(checked);
                        }}
                    />
                )}
            </PanelSectionRow>
            <PanelSectionRow>
                <div style={textStyle}>{statusText}</div>
            </PanelSectionRow>
            {status !== null && (
                <PanelSectionRow>
                    <div style={textStyle}>
                        {`Heute gespielt: ${Math.floor(status.total_play_min_today / 60)}h ${String(status.total_play_min_today % 60).padStart(2, "0")}m`}
                    </div>
                </PanelSectionRow>
            )}
            {status?.state === "playing" && (
                <PanelSectionRow>
                    <div style={textStyle}>{`Session endet in ${formatMMSS(status.session_remaining_s)}`}</div>
                </PanelSectionRow>
            )}
            {status?.state === "breaking" && (
                <PanelSectionRow>
                    <div style={textStyle}>{`Pause endet in ${formatMMSS(status.break_remaining_s)}`}</div>
                </PanelSectionRow>
            )}
        </PanelSection>
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

    const onSuspendNow = () => {
        // Direkt suspendieren — kein setTimeout nötig. Der Backend-Tick friert
        // mit ein und erkennt das Aufwachen am Wanduhr-Sprung.
        void SteamUtils.suspend();
    };

    addEventListener("show_warning", onShowWarning);
    addEventListener("show_break_toast", onShowBreakToast);
    addEventListener("break_over", onBreakOver);
    addEventListener("suspend_now", onSuspendNow);

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
            unregisterGameLifetime?.();
        },
    };
});