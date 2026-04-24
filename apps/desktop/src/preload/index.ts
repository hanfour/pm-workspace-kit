import { contextBridge } from "electron";
import { electronAPI } from "@electron-toolkit/preload";

/**
 * Everything the renderer can call on the main process hangs off
 * `window.pmk`. Expanded in M2.3+ (fs, git, llm). For M2.1 we only
 * expose a version probe so the renderer can prove the bridge works.
 */
const api = {
  ping: (): string => "pong",
  version: (): string => process.versions.electron ?? "unknown",
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("pmk", api);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-expect-error — only taken in non-isolated dev scenarios
  window.electron = electronAPI;
  // @ts-expect-error
  window.pmk = api;
}

export type PmkApi = typeof api;
