import { contextBridge, ipcRenderer } from "electron";
import { electronAPI } from "@electron-toolkit/preload";

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  tracked: boolean;
  children?: TreeNode[];
}

const fs = {
  listWorkspace: (): Promise<{ cwd: string; entries: TreeNode[] }> =>
    ipcRenderer.invoke("pmk:fs:listWorkspace"),
  readFile: (path: string): Promise<string> =>
    ipcRenderer.invoke("pmk:fs:readFile", path),
  writeFile: (
    path: string,
    content: string,
  ): Promise<{ size: number; mtime: number }> =>
    ipcRenderer.invoke("pmk:fs:writeFile", path, content),
};

const llm = {
  chat: (
    systemPrompt: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    onToken: (chunk: string) => void,
  ): Promise<string> => {
    const channel = `pmk:llm:token:${(globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()}`;
    const handler = (_e: unknown, chunk: string) => onToken(chunk);
    ipcRenderer.on(channel, handler);
    return ipcRenderer
      .invoke("pmk:llm:chat", { systemPrompt, messages, channel })
      .finally(() => ipcRenderer.removeListener(channel, handler));
  },
  status: (): Promise<{ providerName: string; hint?: string }> =>
    ipcRenderer.invoke("pmk:llm:status"),
  saveApiKey: (key: string): Promise<void> =>
    ipcRenderer.invoke("pmk:llm:saveApiKey", key),
};

const api = {
  ping: (): string => "pong",
  version: (): string => process.versions.electron ?? "unknown",
  fs,
  llm,
};

console.log("[pmk-preload] loading, contextIsolated=", process.contextIsolated);

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("pmk", api);
    console.log("[pmk-preload] bridge exposed via contextBridge");
  } catch (error) {
    console.error("[pmk-preload] expose failed:", error);
  }
} else {
  const g = globalThis as unknown as Record<string, unknown>;
  g.electron = electronAPI;
  g.pmk = api;
  console.log("[pmk-preload] bridge exposed via globalThis");
}

export type PmkApi = typeof api;
