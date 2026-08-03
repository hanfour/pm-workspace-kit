/**
 * Monthly-partitioned JSONL ledger for the gateway audit feeds
 * (events.log + admin.log). Replaces the v0.10 single-file scheme
 * which was unbounded.
 *
 * Files: `<baseDir>/<prefix>-YYYY-MM.log` — UTC month boundary, NOT
 * the operator's local TZ. Two consequences worth knowing:
 *
 *   1. An event written at 2026-04-30T22:00 in UTC+8 (= 2026-05-01
 *      local) lands in `*-2026-04.log`, not `*-2026-05.log`.
 *      Operators grepping partition files by local date should
 *      account for the offset — or use `pmk gateway audit --days N`
 *      which works in absolute ms windows and doesn't care about
 *      partition naming.
 *   2. UTC is used so multi-host or cross-TZ deployments produce
 *      the same partition file for the same wall-clock event.
 *
 * One JSON object per line; the writer adds an `at` ISO timestamp
 * before stringify. Readers tolerate malformed lines so a single
 * bad write doesn't poison the audit.
 *
 * Back-compat: legacy unpartitioned `<baseDir>/<prefix>.log` files
 * (the v0.10 scheme) are still **read** but no longer written. The
 * reader merges them in front of the partitioned files so an
 * operator who upgraded mid-month doesn't lose history.
 *
 * No eviction. Operators that want to prune old months can `rm`
 * partition files manually; the reader silently skips missing
 * months. Practical scale: ~100 events/day ≈ ~100KB/month
 * uncompressed, so even 10 years is < 12 MB.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface ReadJsonlOptions {
  /**
   * Lower bound on the line's `at` timestamp (ms since epoch). Lines
   * before this are skipped at read time and partitions older than
   * the matching month are skipped at file-open time.
   */
  sinceMs?: number;
  /**
   * Upper bound on how many months back to scan when `sinceMs` isn't
   * given. Defaults to 12 — generous enough for "give me everything"
   * audits without scanning years of partitions on long-lived hosts.
   */
  maxMonthsBack?: number;
}

/** Path to the partition for a given UTC month (defaults to now). */
export function monthlyPath(
  baseDir: string,
  prefix: string,
  d: Date = new Date(),
): string {
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(
    2,
    "0",
  )}`;
  return path.join(baseDir, `${prefix}-${ym}.log`);
}

/**
 * Path to the legacy unpartitioned file. Read-only — kept around so
 * upgrades don't lose history but never written by this build.
 */
export function legacyMonolithPath(baseDir: string, prefix: string): string {
  return path.join(baseDir, `${prefix}.log`);
}

/**
 * Append one JSON object to the current-month partition. Writer
 * stamps an ISO `at` field; caller payload fields override nothing
 * because spread happens after `at` is set (callers shouldn't pass
 * `at` themselves, but if they do their value wins, which preserves
 * back-compat with the prior `appendGatewayEvent` shape).
 *
 * Best-effort: filesystem failures don't propagate, since blocking
 * the gateway on a corrupt audit log would be worse than the
 * missing line.
 */
/**
 * Accounting for lines the audit log could not persist.
 *
 * The swallow above is deliberate and stays — but it used to be invisible:
 * no log, no counter, no doctor check. For a daemon that publishes real
 * GitHub approvals the event log is the only forensic record, so a full disk
 * or a broken permission could stop it recording indefinitely with nothing
 * to notice. Counting costs nothing and makes the silence observable.
 */
interface AuditWriteFailures {
  count: number;
  lastError?: string;
  lastAt?: string;
}

let auditFailures: AuditWriteFailures = { count: 0 };

/** Snapshot of dropped-audit-line accounting (a copy — never the live object). */
export function auditWriteFailures(): AuditWriteFailures {
  return { ...auditFailures };
}

/** Reset the accounting. Exists for tests; production never resets. */
export function resetAuditWriteFailures(): void {
  auditFailures = { count: 0 };
}

export function appendJsonl(
  baseDir: string,
  prefix: string,
  payload: object,
): void {
  try {
    fs.mkdirSync(baseDir, { recursive: true });
    const line =
      JSON.stringify({ at: new Date().toISOString(), ...payload }) + "\n";
    fs.appendFileSync(monthlyPath(baseDir, prefix), line, "utf8");
  } catch (err) {
    // Still non-fatal: blocking the gateway on a broken audit log would be
    // worse than the missing line. Only the silence is removed.
    auditFailures = {
      count: auditFailures.count + 1,
      lastError: (err as Error).message,
      lastAt: new Date().toISOString(),
    };
  }
}

/**
 * Read JSONL lines across legacy + monthly partitions, validated by
 * the caller's predicate. Returns oldest-first (legacy lines, then
 * partitions in chronological order).
 *
 * Predicate is required so each consumer keeps its own discriminated-
 * union contract — the util doesn't know `MraAskEndEvent` from
 * `AdminLogEntry`. Lines that fail JSON.parse OR the predicate are
 * silently dropped.
 */
export function readJsonl<T>(
  baseDir: string,
  prefix: string,
  predicate: (parsed: unknown) => parsed is T,
  opts: ReadJsonlOptions = {},
): T[] {
  const out: T[] = [];

  // Legacy unpartitioned file is always the oldest data.
  const legacy = legacyMonolithPath(baseDir, prefix);
  if (fs.existsSync(legacy)) {
    pushParsedLines(legacy, predicate, opts.sinceMs, out);
  }

  // Decide the start month for partition scan.
  const now = new Date();
  let startYear: number;
  let startMonth: number;
  if (opts.sinceMs !== undefined) {
    const since = new Date(opts.sinceMs);
    startYear = since.getUTCFullYear();
    startMonth = since.getUTCMonth();
  } else {
    const monthsBack = opts.maxMonthsBack ?? 12;
    const back = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1),
    );
    startYear = back.getUTCFullYear();
    startMonth = back.getUTCMonth();
  }

  // Walk months from start through the current UTC month inclusive.
  let y = startYear;
  let m = startMonth;
  // Hard cap — a runaway loop here would be a bug but a defensive
  // bound is cheap insurance against clock weirdness.
  for (let i = 0; i < 240; i++) {
    const file = monthlyPath(baseDir, prefix, new Date(Date.UTC(y, m, 1)));
    if (fs.existsSync(file)) {
      pushParsedLines(file, predicate, opts.sinceMs, out);
    }
    if (
      y > now.getUTCFullYear() ||
      (y === now.getUTCFullYear() && m >= now.getUTCMonth())
    ) {
      break;
    }
    m++;
    if (m > 11) {
      m = 0;
      y++;
    }
  }

  return out;
}

function pushParsedLines<T>(
  file: string,
  predicate: (v: unknown) => v is T,
  sinceMs: number | undefined,
  out: T[],
): void {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!predicate(parsed)) continue;
    if (sinceMs !== undefined) {
      const at = (parsed as { at?: unknown }).at;
      if (typeof at !== "string") continue;
      const t = Date.parse(at);
      if (!Number.isFinite(t) || t < sinceMs) continue;
    }
    out.push(parsed);
  }
}
