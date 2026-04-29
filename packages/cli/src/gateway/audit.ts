/**
 * Aggregator for `pmk gateway audit` (v0.10 / #24).
 *
 * Reads three sources:
 *   1. ~/.pmk/gateway/events.log         (turn / mra-ask / escalate.* events)
 *   2. ~/.pmk/knowledge/<scope>/*.md     (atom corpus, status, contributors)
 *   3. ~/.pmk/gateway/slack/escalations/ (currently-pending markers)
 *
 * Window-scoped numbers (turns, mra-ask, escalate triggered/absorbed)
 * filter events by `at >= now - days*86400_000`. Atom corpus stats are
 * lifetime — atoms don't expire from the knowledge dir, so windowing
 * "total atoms" would be misleading.
 */
import { readGatewayEvents } from "./events";
import { loadAtoms, ATOM_PENDING_TTL_MS } from "./knowledge";
import { listPendingEscalations } from "./session-store";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 7;
/** Pending atom that has lingered this long → flag (auto-promote stuck). */
const ATOM_PENDING_FLAG_MS = ATOM_PENDING_TTL_MS;
/** Pending escalation that has lingered this long → flag (no IT reply). */
const ESCALATE_STALE_FLAG_MS = 48 * 60 * 60 * 1000;

export interface AuditReport {
  windowDays: number;
  windowStartMs: number;
  windowEndMs: number;
  conversations: {
    totalTurns: number;
    perUser: Array<{ userId: string; turns: number }>;
    perAudience: Array<{ audience: string; turns: number }>;
  };
  mraAsk: {
    invocations: number;
    /** ok=true and not retried — the happy path. */
    successes: number;
    /** ok=true but retried — succeeded after the v0.7.3 retry-once. */
    retries: number;
    /** ok=false — failed even with retry. */
    failures: number;
    medianDurationMs: number | undefined;
    topRepos: Array<{ repo: string; count: number }>;
  };
  escalate: {
    triggered: number;
    absorbed: number;
    /** Markers currently on disk under .../escalations/. */
    pending: number;
    /** Median (absorbed.at - triggered.at) for paired events in window. */
    medianTimeToReplyMs: number | undefined;
  };
  atoms: {
    /** Lifetime count, not window-scoped. */
    total: number;
    approved: number;
    pending: number;
    /** Sum of atomsInjected across in-window turns. */
    retrievalInjections: number;
    /** Median atomsInjected per turn, computed over turns where it was > 0. */
    medianAtomsInjectedPerTurn: number | undefined;
    /** Lifetime, by source.contributorUserId. */
    topContributors: Array<{ userId: string; count: number }>;
  };
  flags: string[];
}

export interface BuildAuditReportOptions {
  /** Lookback window. Falls back to 7 on non-positive / non-finite input. */
  days?: number;
  /** Override "now" for tests. Defaults to Date.now(). */
  nowMs?: number;
}

export function buildAuditReport(
  opts: BuildAuditReportOptions = {},
): AuditReport {
  const now = opts.nowMs ?? Date.now();
  const days =
    Number.isFinite(opts.days) && (opts.days as number) > 0
      ? Math.floor(opts.days as number)
      : DEFAULT_WINDOW_DAYS;
  const sinceMs = now - days * DAY_MS;

  const events = readGatewayEvents({ sinceMs });

  const perUser = new Map<string, number>();
  const perAudience = new Map<string, number>();
  let totalTurns = 0;
  let retrievalInjections = 0;
  const injectedSamples: number[] = [];

  let mraInvocations = 0;
  let mraSuccesses = 0;
  let mraRetries = 0;
  let mraFailures = 0;
  const mraDurations: number[] = [];
  const mraRepos = new Map<string, number>();

  let escTriggered = 0;
  let escAbsorbed = 0;
  /**
   * Per-thread FIFO of pending trigger timestamps. Same Slack thread
   * can be re-escalated (first round ignored, user re-asks, pmk fires
   * another escalate) — pair the absorption with the OLDEST unmatched
   * trigger so the median time-to-reply reflects "how long until the
   * original question got answered" rather than the latest re-poke.
   */
  const triggeredAt = new Map<string, number[]>();
  const replyDurations: number[] = [];

  for (const e of events) {
    switch (e.type) {
      case "turn.processed":
        totalTurns++;
        bump(perUser, e.actor);
        bump(perAudience, e.audience);
        if (e.atomsInjected > 0) {
          retrievalInjections += e.atomsInjected;
          injectedSamples.push(e.atomsInjected);
        }
        break;
      case "mra-ask.end":
        mraInvocations++;
        if (e.ok && !e.retried) mraSuccesses++;
        else if (e.ok && e.retried) mraRetries++;
        else mraFailures++;
        mraDurations.push(e.durationMs);
        bump(mraRepos, e.repo);
        break;
      case "escalate.triggered": {
        escTriggered++;
        const k = escKey(e.channelId, e.threadTs);
        const queue = triggeredAt.get(k) ?? [];
        queue.push(Date.parse(e.at));
        triggeredAt.set(k, queue);
        break;
      }
      case "escalate.absorbed": {
        escAbsorbed++;
        const k = escKey(e.channelId, e.threadTs);
        const queue = triggeredAt.get(k);
        const start = queue?.shift();
        if (start !== undefined) {
          const end = Date.parse(e.at);
          if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
            replyDurations.push(end - start);
          }
        }
        break;
      }
    }
  }

  // Audit is observational — never trigger TTL auto-promotion as a
  // side effect of reading. The corpus state we report is exactly
  // what's on disk at the moment of audit.
  const atoms = loadAtoms({ promote: false });
  const approvedAtoms = atoms.filter((a) => a.status !== "pending").length;
  const pendingAtoms = atoms.length - approvedAtoms;
  const contributors = new Map<string, number>();
  for (const a of atoms) bump(contributors, a.source.contributorUserId);

  const pendingEscalations = listPendingEscalations();

  const flags: string[] = [];
  const stuckAtoms = atoms.filter(
    (a) => a.status === "pending" && now - a.createdAt > ATOM_PENDING_FLAG_MS,
  ).length;
  if (stuckAtoms > 0) {
    flags.push(
      `${stuckAtoms} atom(s) have been pending > 24h (auto-promote stuck — gateway not restarted?)`,
    );
  }
  const staleEscalations = pendingEscalations.filter(
    (esc) => now - esc.pendingSince > ESCALATE_STALE_FLAG_MS,
  ).length;
  if (staleEscalations > 0) {
    flags.push(
      `${staleEscalations} escalate(s) with no IT reply for > 48h — consider rejecting marker`,
    );
  }

  return {
    windowDays: days,
    windowStartMs: sinceMs,
    windowEndMs: now,
    conversations: {
      totalTurns,
      perUser: rank(perUser, "userId", "turns"),
      perAudience: rank(perAudience, "audience", "turns"),
    },
    mraAsk: {
      invocations: mraInvocations,
      successes: mraSuccesses,
      retries: mraRetries,
      failures: mraFailures,
      medianDurationMs: median(mraDurations),
      topRepos: rank(mraRepos, "repo", "count"),
    },
    escalate: {
      triggered: escTriggered,
      absorbed: escAbsorbed,
      pending: pendingEscalations.length,
      medianTimeToReplyMs: median(replyDurations),
    },
    atoms: {
      total: atoms.length,
      approved: approvedAtoms,
      pending: pendingAtoms,
      retrievalInjections,
      medianAtomsInjectedPerTurn: median(injectedSamples),
      topContributors: rank(contributors, "userId", "count"),
    },
    flags,
  };
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * Rank a count map into `[{ <keyName>, <countName> }]` sorted by count
 * descending. Generic over the field names so callers get a useful
 * shape without an extra map step.
 */
function rank<K extends string, V extends string>(
  map: Map<string, number>,
  keyName: K,
  countName: V,
): Array<{ [P in K]: string } & { [P in V]: number }> {
  const out: Array<{ [P in K]: string } & { [P in V]: number }> = [];
  for (const [k, count] of map) {
    out.push({ [keyName]: k, [countName]: count } as { [P in K]: string } & {
      [P in V]: number;
    });
  }
  out.sort(
    (a, b) =>
      (b as Record<V, number>)[countName] - (a as Record<V, number>)[countName],
  );
  return out;
}

function median(samples: number[]): number | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function escKey(channelId: string, threadTs: string): string {
  return `${channelId}__${threadTs}`;
}
