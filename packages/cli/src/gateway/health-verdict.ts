import { HEARTBEAT_STALE_MS } from "./heartbeat";
import {
  PONG_TIMEOUT_THRESHOLD,
  UNSTABLE_CONN_LIMIT_MS,
  type ConnState,
} from "./socket-health";

const FRESH_MS = 30_000; // [0,FRESH_MS)=fresh; [FRESH_MS,HEARTBEAT_STALE_MS)=aging; [HEARTBEAT_STALE_MS,∞) or undefined=stale

export type HeartbeatBand = "fresh" | "aging" | "stale";
export type VerdictLevel = "healthy" | "degraded" | "down";

export function heartbeatBand(ageMs: number | undefined): HeartbeatBand {
  if (ageMs === undefined || ageMs >= HEARTBEAT_STALE_MS) return "stale";
  if (ageMs < FRESH_MS) return "fresh";
  return "aging";
}

export interface VerdictInput {
  pidAlive: boolean;
  heartbeatAge: number | undefined;
  /** Optional live socket inputs — only the daemon (Slack doctor) has them. */
  live?: {
    /**
     * Live socket signals (daemon only). These are CURRENT/recent-window and
     * self-healing — deliberately NOT lifetime counters (flaps/confirmedFailures):
     * a routine Slack reconnect should not degrade the verdict forever. Mirrors
     * SocketHealth.assess(): unhealthy iff pong-flood in window or not connected.
     */
    socketState: ConnState;
    /** Pong-timeouts within the 60s window; >= PONG_TIMEOUT_THRESHOLD → degraded. */
    pongTimeoutsInWindow: number;
    /** ms spent not-`connected` (0 when connected); >= UNSTABLE_CONN_LIMIT_MS → degraded. */
    unstableMs: number;
  };
}

export interface Verdict {
  level: VerdictLevel;
  emoji: "🟢" | "🟡" | "🔴";
  note: string;
}

export function verdict(input: VerdictInput): Verdict {
  const band = heartbeatBand(input.heartbeatAge);
  if (!input.pidAlive || band === "stale") {
    return { level: "down", emoji: "🔴", note: "process dead or heartbeat stale" };
  }
  if (input.live) {
    const { socketState, pongTimeoutsInWindow, unstableMs } = input.live;
    const degraded =
      socketState !== "connected" ||
      pongTimeoutsInWindow >= PONG_TIMEOUT_THRESHOLD ||
      unstableMs >= UNSTABLE_CONN_LIMIT_MS ||
      band === "aging";
    return degraded
      ? { level: "degraded", emoji: "🟡", note: "socket/heartbeat degraded" }
      : { level: "healthy", emoji: "🟢", note: "connected" };
  }
  return {
    level: "degraded",
    emoji: "🟡",
    note: "process + heartbeat ok, live socket unknown — see /pmk admin doctor",
  };
}
