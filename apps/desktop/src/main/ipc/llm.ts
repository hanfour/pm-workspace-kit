import { app, ipcMain, safeStorage } from "electron";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@pmk/cli/config";
import {
  NoProviderAvailableError,
  resolveProvider,
  type LlmProvider,
} from "@pmk/cli/llm";

const KEY_FILE = "anthropic-api-key.enc";

function apiKeyPath(): string {
  return join(app.getPath("userData"), KEY_FILE);
}

function loadStoredApiKey(): string | undefined {
  if (!safeStorage.isEncryptionAvailable()) return undefined;
  const p = apiKeyPath();
  if (!existsSync(p)) return undefined;
  try {
    return safeStorage.decryptString(readFileSync(p));
  } catch {
    return undefined;
  }
}

function saveApiKey(key: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "OS keychain not available — cannot store API key securely.",
    );
  }
  writeFileSync(apiKeyPath(), safeStorage.encryptString(key));
}

function buildConfig() {
  const base = loadConfig();
  const stored = loadStoredApiKey();
  return { ...base, apiKey: base.apiKey ?? stored };
}

function tryResolve(): LlmProvider | null {
  try {
    return resolveProvider(buildConfig());
  } catch {
    return null;
  }
}

export function registerLlmHandlers(): void {
  ipcMain.handle("pmk:llm:status", () => {
    try {
      const cfg = buildConfig();
      try {
        const p = resolveProvider(cfg);
        console.log(`[pmk] llm provider resolved: ${p.displayName}`);
        return { providerName: p.displayName };
      } catch (err) {
        console.warn(`[pmk] resolveProvider failed: ${(err as Error).message}`);
        const hint =
          err instanceof NoProviderAvailableError
            ? "Add a Claude Code login or an Anthropic API key to continue."
            : (err as Error).message;
        return { providerName: "none", hint };
      }
    } catch (outer) {
      console.error(`[pmk] status handler error: ${(outer as Error).message}`);
      return {
        providerName: "none",
        hint: `status handler crashed: ${(outer as Error).message}`,
      };
    }
  });

  ipcMain.handle("pmk:llm:saveApiKey", (_e, key: string) => {
    if (!key?.trim()) throw new Error("API key is empty");
    saveApiKey(key.trim());
  });

  // One chat-in-flight per webContents sender. The renderer UI
  // already disables Send while busy, but guard the IPC layer too so
  // a misbehaving or compromised renderer can't spam the provider.
  const inFlight = new Set<number>();

  ipcMain.handle(
    "pmk:llm:chat",
    async (
      event,
      payload: {
        systemPrompt: string;
        messages: Array<{ role: "user" | "assistant"; content: string }>;
        channel: string;
      },
    ) => {
      const senderId = event.sender.id;
      if (inFlight.has(senderId)) {
        throw new Error(
          "another chat is still in flight — wait for the current response to finish",
        );
      }
      const provider = tryResolve();
      if (!provider) {
        throw new Error("no LLM provider available");
      }
      inFlight.add(senderId);
      try {
        return await provider.chat(payload.systemPrompt, payload.messages, {
          onToken: (chunk) => {
            event.sender.send(payload.channel, chunk);
          },
        });
      } finally {
        inFlight.delete(senderId);
      }
    },
  );
}
