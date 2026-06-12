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

/** Activity window for status/doctor "turns/30m" + recent-events queries. */
export const RECENT_ACTIVITY_WINDOW_MS = 30 * 60_000;

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
  /** IDs of the atoms injected this turn (citation linkage for telemetry). */
  atomIds?: string[];
  /** Slack channel/DM the turn ran in. */
  channelId?: string;
  /** Thread anchor, if the turn ran in a thread. */
  threadTs?: string;
  /** Slack ts of the bot reply this turn produced. */
  replyTs?: string;
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

/**
 * Gateway presence transitions (#44 / v0.10.x). Emitted on shutdown
 * and on the first successful Slack reconnect after a start. Lets the
 * audit detect rapid restart cycles, stacked broadcasts, and the
 * graceful-vs-crash split.
 *
 * `seq` is monotonic per gateway PROCESS (resets on each start). Pair
 * it with `at` to reconstruct cross-process ordering.
 *
 * `broadcast` is `false` when the broadcast was suppressed (e.g.,
 * graceful restart shorter than the broadcast threshold). `reason`
 * gives the human-readable why.
 */
export interface GatewayPresenceEvent {
  type: "gateway.online" | "gateway.offline";
  seq: number;
  reason: string;
  broadcast: boolean;
  /** For `gateway.online`: how long the host appears to have been offline (ms). */
  offlineDurationMs?: number;
}

/**
 * Emitted when the model returns a `prompt is too long` 400 at one of
 * the two budget walls — the first call (seed + history + retrieval)
 * or the synthesise call (mra-result fold-in). `sessionTokensBefore`
 * is the gateway's pre-call estimate so audits can correlate against
 * the model's effective limit and tune the safety margin.
 * `retrievalAtoms` is captured separately because retrieval payload is
 * the most common blow-up vector and must be visible without
 * re-deriving it from elsewhere.
 */
export interface ContextExceededEvent {
  type: "context.exceeded";
  actor: string;
  sessionTokensBefore: number;
  retrievalAtoms: number;
  phase: "first-call" | "synthesise";
}

/**
 * Emitted when the retry-after-context-exceeded path force-prunes the
 * session below the normal keep-N to make headroom. `droppedPairs`
 * counts user/assistant pairs evicted; `tokensAfter` is the post-prune
 * estimate — together they reveal whether the wall is repeatedly hit
 * on already-small histories (a sign the seed/retrieval cap is the
 * real culprit, not the rolling history).
 */
export interface ContextForcePrunedEvent {
  type: "context.force-pruned";
  actor: string;
  droppedPairs: number;
  tokensAfter: number;
}

/**
 * Emitted when seed input or mra-result payload is hard-capped before
 * being sent to the model. `originalChars`/`cappedChars` make the
 * truncation ratio inspectable so operators can see when the cap is
 * trimming meaningful content vs trailing noise.
 */
export interface MessageCappedEvent {
  type: "message.capped";
  actor: string;
  kind: "seed" | "mra-result" | "attachment";
  originalChars: number;
  cappedChars: number;
}

/**
 * Per-call token accounting (v0.12.0). Emitted once per model round so
 * audits can attribute spend to the actor and reveal cache effectiveness
 * (cache reads are billed at a fraction of input tokens). The cache
 * fields are optional because not every provider/model surfaces them —
 * absence means "not reported", not "zero".
 */
export interface TokenUsageEvent {
  type: "token.usage";
  actor: string;
  provider: "anthropic-api" | "claude-agent";
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Present only when prompt caching was active. */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface GithubIssueCreatedEvent {
  type: "github.issue.created";
  /** Slack user id of the 🎫 reactor. */
  actor: string;
  /** owner/repo slug. */
  repo: string;
  /** Created issue URL. */
  url: string;
}

export interface GithubIssueFailedEvent {
  type: "github.issue.failed";
  actor: string;
  /** Optional — may fail before the slug resolves. */
  repo?: string;
  /** no-gh | token | slug | public-repo | gh-create-failed */
  reason: string;
}

export type GatewayEvent =
  | MraAskEndEvent
  | TurnProcessedEvent
  | EscalateTriggeredEvent
  | EscalateAbsorbedEvent
  | GatewayPresenceEvent
  | ContextExceededEvent
  | ContextForcePrunedEvent
  | MessageCappedEvent
  | TokenUsageEvent
  | GithubIssueCreatedEvent
  | GithubIssueFailedEvent;

/** What lands on disk: the event plus the ISO timestamp added at append time. */
export type StoredGatewayEvent = GatewayEvent & { at: string };

const VALID_TYPES: ReadonlySet<string> = new Set([
  "mra-ask.end",
  "turn.processed",
  "escalate.triggered",
  "escalate.absorbed",
  "gateway.online",
  "gateway.offline",
  "context.exceeded",
  "context.force-pruned",
  "message.capped",
  "token.usage",
  "github.issue.created",
  "github.issue.failed",
]);

/**
 * v0.16 (M3): events partition switches to `dryrun-events-YYYY-MM.log`
 * when `PMK_DRY_RUN=1` so a dry-run session doesn't pollute the real
 * audit log. The env var is process-local; reads from a separate CLI
 * process (e.g., `pmk gateway audit`) see the production partition
 * unless explicitly run with the env var set.
 */
function eventsPrefix(): string {
  return process.env.PMK_DRY_RUN === "1" ? "dryrun-events" : "events";
}

/**
 * Path to the current month's events partition. Exposed for tests
 * that inject synthetic / malformed lines and for operators tailing
 * the live feed (e.g., `tail -f $(pmk debug events-path)`). The
 * returned path moves on UTC month boundaries; callers that need a
 * specific month should compute it themselves via `monthlyPath`.
 */
export function gatewayEventsPath(): string {
  return monthlyPath(gatewayDir(), eventsPrefix());
}

/**
 * Append a structured event. Best-effort — failures to write don't
 * propagate, since blocking the gateway on a corrupt audit log would
 * be worse than the missing line. Mirrors {@link appendAdminLog}.
 */
export function appendGatewayEvent(event: GatewayEvent): void {
  appendJsonl(gatewayDir(), eventsPrefix(), event);
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
  const all = readJsonl(gatewayDir(), eventsPrefix(), isStoredGatewayEvent, {
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
