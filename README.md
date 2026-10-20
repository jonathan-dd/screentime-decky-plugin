# ScreenTime — Decky-Plugin für die Steam Deck

**ScreenTime** erzwingt regelmäßige Spielpausen auf der Steam Deck: Sitzungen
werden zeitlich begrenzt, vor Sitzungsende gewarnt, und danach wird das Gerät
in den Ruhemodus versetzt, bis die Pause vorüber ist.

## Features

- **Sitzungslimit:** Jede Spielsitzung wird nach 20 Minuten beendet.
- **Vorankündigung:** 1 Minute vor Sitzungsende erscheint ein Toast
  („Noch 1 Minute Spielzeit …“).
- **Erzwungene Pause:** Nach Sitzungsende folgt eine 10-minütige Pause. Das
  Gerät wird in den Ruhemodus versetzt; nach jedem Aufwachen bleibt es nur
  ca. 30 Sekunden wach (für den „Noch X Minuten Pause“-Toast) und schläft dann
  erneut ein, bis die Pause um ist.
- **Tageslimit:** Insgesamt 2 Stunden Spielzeit pro Tag. Wird das Limit (auch
  mitten in einer Sitzung) erreicht, wird die Sitzung sofort beendet; alle
  weiteren Sitzungen des Tages sind auf 5 Minuten verkürzt.
- **Mitternachts-Reset:** Der Tageszähler wird automatisch bei Datumswechsel
  zurückgesetzt (persistiert, übersteht Neustarts).
- **An/Aus:** Schalter „Aktiv“ im Schnellzugriffsmenü (QAM); die Einstellung
  wird persistiert.
- **Statusanzeige:** Status („Aus / Spielzeit läuft / Erzwungene Pause“),
  heute gespielte Zeit sowie verbleibende Sitzungs- bzw. Pausenzeit im Panel.

## Verhalten im Detail

| Konstante | Wert | Bedeutung |
| --- | --- | --- |
| `SESSION_NORMAL_S` | 1200 s (20 min) | Normale Sitzungslänge |
| `SESSION_REDUCED_S` | 300 s (5 min) | Sitzungslänge nach erreichtem Tageslimit |
| `BREAK_S` | 600 s (10 min) | Erzwungene Pause |
| `WARN_BEFORE_S` | 60 s | Vorankündigung vor Sitzungsende |
| `DAILY_LIMIT_S` | 7200 s (2 h) | Tageslimit an Spielzeit |
| `MANUAL_SUSPEND_GAP_S` | 30 s | Wanduhr-Sprung, ab dem Suspend/Wake erkannt wird |
| `TOAST_AFTER_WAKE_S` | 20 s | Wachzeit bis zum Pause-Toast |
| `RESUSPEND_AFTER_TOAST_S` | 10 s | Weitere Wachzeit, dann erneut Ruhemodus |

### Zeitlogik

- Der Backend-Prozess friert beim System-Suspend ein: `time.monotonic()`
  zählt nur Wachzeit, `time.time()` (Wanduhr) läuft weiter. Spielzeit wird
  daher über monotonic aufsummiert — Schlafzeit zählt nicht als Spielzeit.
- Die 10-minütige Pause zählt in **Wanduhr** ab der ersten Suspension
  (inklusive Schlafzeit): Schläft das Gerät während der Pause, läuft die
  Pausenzeit weiter. Ein manueller Sleep (Taste drücken) während des Spiels
  nach der Vorankündigung startet die Pause entsprechend rückwirkend zum
  Zeitpunkt der Suspension.
- **Suspend/Wake-Erkennung:** Ein Wanduhr-Sprung zwischen zwei Ticks von mehr
  als 30 Sekunden wird als Suspend/Wake interpretiert.
- Manuelles Einschlafen **vor** der Vorankündigung verwirft die laufende
  Sitzung (Timer startet beim Aufwachen neu).

## Installation

Voraussetzung: [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader)
auf der Steam Deck.

1. Plugin über den Decky-Plugin-Browser installieren **oder** dieses
   Repository nach `~/homebrew/plugins/screentime-decky-plugin` klonen bzw.
   kopieren.
2. Steam neu starten (oder das Gerät neu booten), damit Decky das Plugin
   lädt.
3. Schnellzugriffsmenü (QAM) öffnen → Eintrag **ScreenTime**.

Entwicklung: `pnpm install && pnpm build` baut `dist/index.js` (Rollup über
`@decky/rollup`). Python-Backend ist reine Standardbibliothek, es sind keine
externen Abhängigkeiten nötig.

## Bekannte Einschränkungen

- **Nur Game Mode:** Das Plugin funktioniert nur im Game Mode von SteamOS.
  Im Desktop Mode stehen die Steam-Client-JS-APIs nicht zur Verfügung.
- **Plugin-Load mitten im Spiel:** Wird das Plugin geladen, während bereits ein
  Spiel läuft, startet der Sitzungs-Timer erst beim nächsten Steam-App-Event
  (Start oder Stop einer App) bzw. über die Best-effort-Abfrage bereits
  laufender Apps — die Steam-Client-API meldet den Startzeitpunkt einer
  bereits laufenden App nicht; fehlt `GetRunningApps`, läuft der Timer erst
  mit dem nächsten App-Wechsel an.
- **Kein Sperr-Mechanismus:** Die Durchsetzung erfolgt über Suspend-Zyklen;
  die Pause selbst („wach bleiben statt weiterspielen“) lässt sich technisch
  nicht bulletproof erzwingen.
- Bei sehr langen Pausen (>10 min Schlafzeit) gilt die Pause beim Aufwachen als
  abgelaufen.

## Lizenz

[MIT](LICENSE) — Copyright (c) 2026 Jonathan Dechow