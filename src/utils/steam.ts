import { findModuleChild, Module } from "@decky/ui";

// SteamUtils: Zugriff auf die Suspend-Funktion des Steam-Clients.
// @decky/ui exportiert selbst kein SteamUtils — das Modul wird daher wie im
// AlarMe-Plugin über findModuleChild aus den Steam-UI-Webpack-Modulen geholt.
const findModule = (property: string) => {
    return findModuleChild((m: Module) => {
        if (typeof m !== "object") return undefined;
        for (const prop in m) {
            try {
                if (m[prop][property]) {
                    return m[prop];
                }
            } catch {
                return undefined;
            }
        }
    });
};

const SleepParent = findModule("InitiateSleep");

export class SteamUtils {
    static async suspend() {
        SleepParent?.OnSuspendRequest?.();
    }
}