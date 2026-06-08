import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { gatewayDir } from "./config";
import { readJsonFile, writeJsonFile } from "./json-store";

export interface GatewayRunState {
  pid: number;
  startedAt: number;
  phase: "starting" | "ready";
  supervised: "launchd" | null;
  serviceLabel?: string;
}

export const SERVICE_LABEL = "com.pmk.gateway";

function runStatePath(): string {
  return path.join(gatewayDir(), "runtime.json");
}

function isRunState(v: unknown): v is GatewayRunState {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as GatewayRunState).pid === "number" &&
    typeof (v as GatewayRunState).startedAt === "number"
  );
}

export function writeRunState(state: GatewayRunState): void {
  writeJsonFile(runStatePath(), state);
}

export function removeRunState(): void {
  try {
    fs.unlinkSync(runStatePath());
  } catch {
    /* may already be gone */
  }
}

/** The file as-is — may be stale (pid dead). For `status`, never liveness-gated. */
export function readGatewayRunStateRaw(): GatewayRunState | undefined {
  return readJsonFile(runStatePath(), isRunState);
}

/** Raw + liveness-checked via signal 0. undefined if not actually running. */
export function gatewayLiveRunState(): GatewayRunState | undefined {
  const raw = readGatewayRunStateRaw();
  if (!raw) return undefined;
  try {
    process.kill(raw.pid, 0);
    return raw;
  } catch {
    return undefined;
  }
}

export function serviceLabelValid(label: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(label);
}

function launchAgentPath(label = SERVICE_LABEL): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

/** The LaunchAgent plist exists on disk (installed, may or may not be loaded). */
export function installedPlist(label = SERVICE_LABEL):
  | { label: string; plistPath: string }
  | undefined {
  const plistPath = launchAgentPath(label);
  return fs.existsSync(plistPath) ? { label, plistPath } : undefined;
}

/** The service is loaded in the launchd domain (`launchctl print` succeeds). */
export function loadedService(label = SERVICE_LABEL): boolean {
  if (!serviceLabelValid(label)) return false;
  const uid = process.getuid?.();
  if (uid === undefined) return false; // non-POSIX (no launchd)
  try {
    execFileSync("launchctl", ["print", `gui/${uid}/${label}`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
