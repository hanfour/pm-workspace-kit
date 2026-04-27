import * as fs from "node:fs";
import * as path from "node:path";
import { gatewayDir, gatewayHeartbeatPath } from "./config";

/** Stale threshold — over this we assume the host slept / restarted. */
export const HEARTBEAT_STALE_MS = 60_000;

/** Tick interval — must be < HEARTBEAT_STALE_MS / 2 to avoid false positives. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

export interface HeartbeatStartResult {
  /** True when the previous heartbeat was missing or older than HEARTBEAT_STALE_MS. */
  wasOffline: boolean;
  /** Last recorded heartbeat timestamp (ms epoch), or undefined if no prior. */
  lastSeenAt?: number;
  /** Returned so the caller can later `stop()` the timer. */
  stop: () => void;
}

/**
 * Start the heartbeat loop. Returns whether the host was offline at the
 * moment of start (so the caller can broadcast a "back online" notice).
 */
export function startHeartbeat(): HeartbeatStartResult {
  fs.mkdirSync(gatewayDir(), { recursive: true });
  const file = gatewayHeartbeatPath();

  let lastSeenAt: number | undefined;
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, "utf8").trim();
      const ts = parseInt(raw, 10);
      if (Number.isFinite(ts)) lastSeenAt = ts;
    } catch {
      /* ignore unreadable */
    }
  }

  const now = Date.now();
  const wasOffline =
    lastSeenAt === undefined || now - lastSeenAt > HEARTBEAT_STALE_MS;

  writeHeartbeat();
  const handle = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);
  // Don't keep the event loop alive just for the heartbeat.
  handle.unref();

  return {
    wasOffline,
    lastSeenAt,
    stop: () => clearInterval(handle),
  };
}

function writeHeartbeat(): void {
  try {
    fs.writeFileSync(gatewayHeartbeatPath(), Date.now().toString(), "utf8");
  } catch {
    /* non-fatal: a missed heartbeat just means the next start may
       falsely think we were offline */
  }
}

/** Best-effort cleanup: delete the heartbeat file. Used on graceful shutdown. */
export function clearHeartbeat(): void {
  try {
    fs.unlinkSync(gatewayHeartbeatPath());
  } catch {
    /* may not exist; not fatal */
  }
}
