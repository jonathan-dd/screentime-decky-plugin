import type { CSSProperties } from "react";

// Dezente, Steam-nahe Farbtokens für die Statusanzeige (bewusst gedeckte
// Farben statt knalliger Akzente — QAM-Optik bleibt ruhig).
export const STATUS_COLORS = {
    /** Spielzeit läuft */
    playing: "#a3cd39",
    /** Erzwungene Pause */
    breaking: "#e69900",
    /** Bereit (aktiv, kein Spiel läuft) */
    ready: "#1a9fff",
    /** Aus / wird geladen */
    off: "#67707b",
} as const;

export interface StatusVisual {
    color: string;
    label: string;
}

interface StatusCardProps {
    visual: StatusVisual;
    /** Interpolierte Restzeit (mm:ss) der laufenden Session/Pause; null = keine aktive Phase. */
    countdown: string | null;
    /** Fortschritt der aktuellen Phase (0..1); null = kein Füllstand. */
    progress: number | null;
    /** Wertzeile für „Heute gespielt", z. B. "2h 05m von 3h". */
    todayText: string;
}

const cardStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    width: "100%",
    boxSizing: "border-box",
    padding: "10px 12px",
    borderRadius: "8px",
    background: "rgba(255, 255, 255, 0.04)",
};

const statusRowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    minWidth: 0,
};

const statusLabelStyle: CSSProperties = {
    fontSize: "14px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
};

const countdownCaptionStyle: CSSProperties = {
    fontSize: "11px",
    color: "#888888",
    flexShrink: 0,
};

const trackStyle: CSSProperties = {
    width: "100%",
    height: "6px",
    borderRadius: "3px",
    background: "rgba(255, 255, 255, 0.08)",
    overflow: "hidden",
};

const todayRowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    minWidth: 0,
};

const todayLabelStyle: CSSProperties = {
    fontSize: "12px",
    color: "#888888",
    whiteSpace: "nowrap",
};

const todayValueStyle: CSSProperties = {
    fontSize: "13px",
    color: "#dcdcdc",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
};

const spacerStyle: CSSProperties = {
    flex: 1,
    minWidth: 0,
};

/**
 * Kompakter Status-Block für das schmale QAM-Panel:
 * Statuszeile (farbiger Punkt + Label, rechts Restzeit als mm:ss), darunter
 * ein schmaler Fortschrittsbalken (Session-Fortschritt bzw. Pausen-Fortschritt,
 * per 250-ms-Interpolation weich laufend) und die „Heute gespielt"-Zeile im
 * Label-Wert-Layout.
 */
export function StatusCard({ visual, countdown, progress, todayText }: StatusCardProps) {
    const dotStyle: CSSProperties = {
        width: "9px",
        height: "9px",
        borderRadius: "50%",
        background: visual.color,
        boxShadow: `0 0 6px ${visual.color}66`,
        flexShrink: 0,
    };

    const countdownStyle: CSSProperties = {
        fontSize: "15px",
        fontWeight: 600,
        color: countdown !== null ? visual.color : "#888888",
        fontVariantNumeric: "tabular-nums",
        flexShrink: 0,
    };

    // 250-ms-Transition passend zum Anzeige-Tick: Der Balken füllt sich
    // kontinuierlich statt im 2-s-Poll-Raster zu springen.
    const fillStyle: CSSProperties = {
        height: "100%",
        borderRadius: "3px",
        background: visual.color,
        width:
            progress !== null
                ? `${Math.min(100, Math.max(0, progress * 100)).toFixed(1)}%`
                : "0%",
        transition: "width 250ms linear",
    };

    return (
        <div style={cardStyle}>
            <div style={statusRowStyle}>
                <span style={dotStyle} />
                <span style={statusLabelStyle}>{visual.label}</span>
                <span style={spacerStyle} />
                {countdown !== null && (
                    <span style={countdownCaptionStyle}>Endet in</span>
                )}
                <span style={countdownStyle}>{countdown ?? ""}</span>
            </div>
            <div style={trackStyle}>
                <div style={fillStyle} />
            </div>
            <div style={todayRowStyle}>
                <span style={todayLabelStyle}>Heute gespielt</span>
                <span style={spacerStyle} />
                <span style={todayValueStyle}>{todayText}</span>
            </div>
        </div>
    );
}
