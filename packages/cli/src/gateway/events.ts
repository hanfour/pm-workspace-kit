/**
 * Append-only structured event log for the gateway (v0.10 / #24).
 *
 * The freeform `[pmk-gw] ...` breadcrumbs printed to stdout are good
 * for live tailing but lossy and unstructured. `pmk gateway audit`
 * needs reliable counts of mra-ask outcomes, retrieval injections,
 * audience splits, and escalation lifetimes — none of which are
 * recoverable from prose log lines.
 *
 * This module mirrors `admin-log.ts` (v0.9 / #31) deliberately:
 * JSONL, best-effort writes, tolerant reader. Different file
 * (`events.log` vs `admin.log`) so admin actions stay isolated and
 * each can be rotated independently.
 *
 * Events are domain-shaped, not transport-shaped — the consumer is
 * the audit aggregator, not Prometheus. A future exporter to OTel /
 * structured logging is out of scope.
 */

import type { AudienceKey } from "@pmk/shared";
import { gatewayDir } from "./config";
import { appendJsonl, monthlyPath, readJsonl } from "./monthly-jsonl";

// TODO(v0.10.x): events.log grows unbounded. At single-host workloads
// (~100 events/day) we'd hit ~1MB/year — acceptable for now but the
// admin.log has the same gap; a single rotation helper covering both
// is the right shape when we get there.

/**
 * `mra ask` round outcome. `retried=true` means the call succeeded or
 * failed only after the v0.7.3 retry-once kicked in. `durationMs`
 * covers the full runMraAsk window including any retry, since that is
 * what the user perceived.
 */
export interface MraAskEndEvent {
  type: "mra-ask.end";
  /** Slack user ID that triggered the round. */
  actor: string;
  repo: string;
  ok: boolean;
  retried: boolean;
  durationMs: number;
}

/**
 * One bot reply turn. Audience is captured at turn time so historical
 * audits are not invalidated by later config changes (the alternative
 * — re-resolving via `pickAudience(cfg, actor)` at audit time —
 * silently rewrites history).
 */
export interface TurnProcessedEvent {
  type: "turn.processed";
  actor: string;
  /**
   * Tightened to {@link AudienceKey} (rather than `string`) so emitter
   * sites can't slip in a typo'd tier. The reader still tolerates any
   * string (legacy events from earlier dev builds aren't rejected) —
   * only the write boundary is policed.
   */
  audience: AudienceKey;
  hadMraAsk: boolean;
  /** Number of approved knowledge atoms injected via retrieval. */
  atomsInjected: number;
}

export interface EscalateTriggeredEvent {
  type: "escalate.triggered";
  channelId: string;
  threadTs: string;
  scope?: string;
}

/**
 * Emitted when an IT contributor reply lands and the absorber writes a
 * pending atom. `atomId` is omitted if absorption failed to land an
 * atom (e.g. extractor returned no candidate); the audit treats those
 * as absorbed-without-atom and surfaces the gap.
 */
export interface EscalateAbsorbedEvent {
  type: "escalate.absorbed";
  channelId: string;
  threadTs: string;
  atomId?: string;
}

export type GatewayEvent =
  | MraAskEndEvent
  | TurnProcessedEvent
  | EscalateTriggeredEvent
  | EscalateAbsorbedEvent;

/** What lands on disk: the event plus the ISO timestamp added at append time. */
export type StoredGatewayEvent = GatewayEvent & { at: string };

const VALID_TYPES: ReadonlySet<string> = new Set([
  "mra-ask.end",
  "turn.processed",
  "escalate.triggered",
  "escalate.absorbed",
]);

/**
 * Path to the current month's events partition. Exposed for tests
 * that inject synthetic / malformed lines and for operators tailing
 * the live feed (e.g., `tail -f $(pmk debug events-path)`). The
 * returned path moves on UTC month boundaries; callers that need a
 * specific month should compute it themselves via `monthlyPath`.
 */
export function gatewayEventsPath(): string {
  return monthlyPath(gatewayDir(), "events");
}

/**
 * Append a structured event. Best-effort — failures to write don't
 * propagate, since blocking the gateway on a corrupt audit log would
 * be worse than the missing line. Mirrors {@link appendAdminLog}.
 */
export function appendGatewayEvent(event: GatewayEvent): void {
  appendJsonl(gatewayDir(), "events", event);
}

export interface ReadGatewayEventsOptions {
  /** Only return events with `at` >= this epoch ms. */
  sinceMs?: number;
  /** Tail to last N entries (applied after sinceMs). */
  limit?: number;
}

/**
 * Read parsed events. Returns [] on missing file, read error, or all
 * lines being malformed. Malformed lines are silently skipped so a
 * single bad write doesn't poison the audit.
 */
export function readGatewayEvents(
  opts: ReadGatewayEventsOptions = {},
): StoredGatewayEvent[] {
  const all = readJsonl(gatewayDir(), "events", isStoredGatewayEvent, {
    sinceMs: opts.sinceMs,
  });
  if (opts.limit !== undefined && opts.limit >= 0 && all.length > opts.limit) {
    return all.slice(all.length - opts.limit);
  }
  return all;
}

function isStoredGatewayEvent(v: unknown): v is StoredGatewayEvent {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.at !== "string" || typeof o.type !== "string") return false;
  return VALID_TYPES.has(o.type);
}
