/**
 * Pure health tracker for the Slack Socket-Mode connection. No I/O, no
 * timers, no clock of its own — every method takes `nowMs`. Fed by the
 * pong-tap logger (Unit C) and the adapter's conn-state listeners; read
 * by the SocketWatchdog.
 */

export type ConnState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnecting"
  | "disconnected";

/** Rolling window for counting pong-timeouts. */
export const PONG_TIMEOUT_WINDOW_MS = 60_000;
/** Pong-timeouts within the window that flip the verdict to unhealthy. */
export const PONG_TIMEOUT_THRESHOLD = 3;
/** Max time not-`connected` before the connection is judged unhealthy. */
export const UNSTABLE_CONN_LIMIT_MS = 60_000;

export class SocketHealth {
  private pongTimeouts: number[] = [];
  private state: ConnState = "connecting";
  private stateSince: number;
  private lastPongTimeoutAt: number | null = null;

  constructor(startNowMs: number) {
    this.stateSince = startNowMs;
  }

  recordPongTimeout(nowMs: number): void {
    this.pongTimeouts.push(nowMs);
    this.lastPongTimeoutAt = nowMs;
    this.prune(nowMs);
  }

  recordConnState(state: ConnState, nowMs: number): void {
    if (state !== this.state) {
      this.state = state;
      this.stateSince = nowMs;
    }
  }

  assess(nowMs: number): "healthy" | "unhealthy" {
    this.prune(nowMs);
    if (this.pongTimeouts.length >= PONG_TIMEOUT_THRESHOLD) return "unhealthy";
    if (this.state !== "connected" && nowMs - this.stateSince > UNSTABLE_CONN_LIMIT_MS) {
      return "unhealthy";
    }
    return "healthy";
  }

  /**
   * Clear ONLY the pong-timeout evidence (so the flood window restarts
   * fresh after a forced reconnect). The conn-state machine is
   * event-driven and is deliberately NOT touched — right after a
   * successful reconnect it already holds the fresh `connected`-since
   * anchor that `lastStableConnectedSince` needs.
   */
  reset(_nowMs: number): void {
    this.pongTimeouts = [];
    this.lastPongTimeoutAt = null;
  }

  /**
   * `null` iff not currently `connected`. When connected, the later of
   * {entered-connected, most-recent pong-timeout}: a non-connected state
   * breaks the stretch (null); a pong-timeout while connected merely
   * restarts the stable clock from that instant.
   */
  lastStableConnectedSince(_nowMs: number): number | null {
    if (this.state !== "connected") return null;
    return this.lastPongTimeoutAt !== null
      ? Math.max(this.stateSince, this.lastPongTimeoutAt)
      : this.stateSince;
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - PONG_TIMEOUT_WINDOW_MS;
    if (this.pongTimeouts.length > 0 && this.pongTimeouts[0] < cutoff) {
      this.pongTimeouts = this.pongTimeouts.filter((t) => t >= cutoff);
    }
  }
}
