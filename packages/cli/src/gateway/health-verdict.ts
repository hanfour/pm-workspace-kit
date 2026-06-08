import { HEARTBEAT_STALE_MS } from "./heartbeat";
import type { ConnState } from "./socket-health";

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
  /** Optional live socket/watchdog inputs — only the daemon (Slack doctor) has them. */
  live?: {
    /** Live socket/watchdog (daemon only). flaps = watchdog reconnect-reactions this session; any >0 → degraded. */
    socketState: ConnState;
    flaps: number;
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
    const degraded =
      input.live.socketState !== "connected" || input.live.flaps > 0 || band === "aging";
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
