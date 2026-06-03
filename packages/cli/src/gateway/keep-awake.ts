/**
 * macOS keep-awake: hold a `caffeinate` power assertion bound to the
 * gateway's own pid (`-w <pid>`), so a backgrounded daemon can't be
 * App-Nap/idle-sleep throttled into starving Slack's Socket-Mode
 * ping/pong. No-op on every non-macOS platform. Best-effort: a spawn
 * failure must never block the gateway from starting.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

/**
 * Default flags: `-i` (prevent idle system sleep) + `-s` (prevent system
 * sleep on AC). Deliberately NOT `-dimsu` — `-d` holds the display awake
 * (battery/screen cost). `-dimsu` is the verified-working escalation,
 * available via PMK_GATEWAY_CAFFEINATE_FLAGS, not the default.
 */
export const DEFAULT_CAFFEINATE_FLAGS = "-is";

export interface KeepAwakeDeps {
  platform?: NodeJS.Platform;
  pid?: number;
  spawn?: typeof nodeSpawn;
  /** Override flags string; defaults to PMK_GATEWAY_CAFFEINATE_FLAGS env or DEFAULT. */
  flagsEnv?: string | undefined;
  onLog?: (msg: string) => void;
}

export interface KeepAwakeHandle {
  stop: () => void;
}

export function startKeepAwake(deps: KeepAwakeDeps = {}): KeepAwakeHandle {
  const platform = deps.platform ?? process.platform;
  const onLog = deps.onLog ?? (() => {});
  if (platform !== "darwin") return { stop: () => {} };

  const pid = deps.pid ?? process.pid;
  const spawn = deps.spawn ?? nodeSpawn;
  const flagsRaw =
    deps.flagsEnv ?? process.env.PMK_GATEWAY_CAFFEINATE_FLAGS ?? DEFAULT_CAFFEINATE_FLAGS;
  const flags = flagsRaw.split(/\s+/).filter(Boolean);
  const args = [...flags, "-w", String(pid)];

  let child: ChildProcess | undefined;
  let stopped = false;
  try {
    child = spawn("caffeinate", args, { stdio: "ignore" });
    child.unref();
    child.on("error", (err: Error) => {
      onLog(`keep-awake: caffeinate failed to start (${err.message}); gateway is NOT throttle-protected`);
    });
    child.on("exit", (code) => {
      if (!stopped) {
        onLog(`keep-awake: caffeinate exited unexpectedly (code ${code}); gateway is NOT throttle-protected`);
      }
    });
  } catch (err) {
    onLog(`keep-awake: could not spawn caffeinate (${(err as Error).message}); continuing without throttle protection`);
  }

  return {
    stop: () => {
      stopped = true;
      try {
        child?.kill();
      } catch {
        /* already gone */
      }
    },
  };
}
