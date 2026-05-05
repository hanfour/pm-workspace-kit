import * as fs from "node:fs";
import {
  gatewayDir,
  gatewayHeartbeatPath,
  gatewayShutdownMarkerPath,
} from "./config";

/** Stale threshold — over this we assume the host slept / restarted. */
export const HEARTBEAT_STALE_MS = 60_000;

/** Tick interval — must be < HEARTBEAT_STALE_MS / 2 to avoid false positives. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

export interface HeartbeatStartResult {
  /**
   * True when the previous run did not exit gracefully AND either
   * there was no prior heartbeat OR the apparent offline gap is
   * older than HEARTBEAT_STALE_MS. Drives the "back online"
   * broadcast decision — graceful restarts within the stale window
   * do NOT get one.
   */
  wasOffline: boolean;
  /** Last recorded heartbeat timestamp (ms epoch), or undefined if no prior. */
  lastSeenAt?: number;
  /**
   * Apparent offline duration in ms. Sourced from the graceful
   * shutdown marker timestamp if present, else from `lastSeenAt`.
   * Undefined on the very first start (no marker, no heartbeat).
   */
  offlineDurationMs?: number;
  /**
   * True iff a graceful-shutdown marker was found (and consumed) at
   * startup. Lets the caller distinguish "kill -> restart" from
   * "crash -> restart" — both can produce the same heartbeat
   * staleness, but only the latter should broadcast.
   */
  gracefulShutdown: boolean;
  /** Returned so the caller can later `stop()` the timer. */
  stop: () => void;
}

/**
 * Start the heartbeat loop and resolve the presence-broadcast intent
 * for this start (#44):
 *
 *   - No prior heartbeat & no marker  → first ever boot, `wasOffline=true`
 *   - Marker present + gap ≤ stale    → graceful restart, `wasOffline=false`
 *   - Marker present + gap > stale    → graceful shutdown then long downtime
 *                                       (e.g., machine slept), `wasOffline=true`
 *   - No marker + heartbeat fresh     → fast crash recovery, `wasOffline=false`
 *   - No marker + heartbeat stale     → real crash + downtime, `wasOffline=true`
 *
 * The marker is consumed (deleted) once read, so each graceful
 * shutdown grants exactly one suppressed restart.
 */
export function startHeartbeat(): HeartbeatStartResult {
  fs.mkdirSync(gatewayDir(), { recursive: true });
  const heartbeatFile = gatewayHeartbeatPath();
  const markerFile = gatewayShutdownMarkerPath();

  const lastSeenAt = readEpochFile(heartbeatFile);
  const markerTs = readEpochFile(markerFile);
  if (fs.existsSync(markerFile)) {
    // Single-use marker — clear regardless of parse success so a
    // corrupt marker can't permanently mute back-online broadcasts.
    try {
      fs.unlinkSync(markerFile);
    } catch {
      /* not fatal; worst case, next start also sees graceful */
    }
  }

  const now = Date.now();
  const referenceTs = markerTs ?? lastSeenAt;
  const offlineDurationMs =
    referenceTs !== undefined ? now - referenceTs : undefined;
  const wasOffline =
    offlineDurationMs === undefined ||
    offlineDurationMs > HEARTBEAT_STALE_MS;

  writeHeartbeat();
  const handle = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);
  // Don't keep the event loop alive just for the heartbeat.
  handle.unref();

  return {
    wasOffline,
    lastSeenAt,
    offlineDurationMs,
    gracefulShutdown: markerTs !== undefined,
    stop: () => clearInterval(handle),
  };
}

function readEpochFile(file: string): number | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    const ts = parseInt(raw, 10);
    return Number.isFinite(ts) ? ts : undefined;
  } catch {
    return undefined;
  }
}

function writeHeartbeat(): void {
  try {
    fs.writeFileSync(gatewayHeartbeatPath(), Date.now().toString(), "utf8");
  } catch {
    /* non-fatal: a missed heartbeat just means the next start may
       falsely think we were offline */
  }
}

/**
 * Drop a graceful-shutdown marker (#44). Called by the gateway
 * shutdown handler so the next start knows this exit was intentional
 * and can suppress the spurious "back online" broadcast.
 *
 * Best-effort: if the write fails the next start falls back to
 * crash-recovery semantics — cosmetic broadcast spam, no functional
 * regression.
 */
export function markGracefulShutdown(): void {
  try {
    fs.writeFileSync(
      gatewayShutdownMarkerPath(),
      Date.now().toString(),
      "utf8",
    );
  } catch {
    /* see comment above — cosmetic only */
  }
}

/**
 * Best-effort cleanup: delete the heartbeat file. Used on startup
 * failure (so a half-bound start doesn't poison the next try) and
 * by tests.
 */
export function clearHeartbeat(): void {
  try {
    fs.unlinkSync(gatewayHeartbeatPath());
  } catch {
    /* may not exist; not fatal */
  }
}
