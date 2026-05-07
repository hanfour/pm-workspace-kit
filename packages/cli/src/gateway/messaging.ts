/**
 * Gateway message builders + small text utilities. Extracted from the
 * Slack adapter so they can be unit-tested in isolation and reused by
 * other adapters (LINE etc.) when those land.
 */

import type { ChatMessage } from "@pmk/shared";
import {
  listMraWorkspaceReposWithPkb,
  loadPkbBase,
  mraDoctor,
  resolveMraRepo,
} from "../adapters/mra";

/**
 * Trim a string to `max` characters, appending a one-line "(truncated
 * N chars)" marker so consumers can see something was clipped. Strings
 * shorter than `max` are returned verbatim.
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…(truncated ${s.length - max} chars)`;
}

export interface CapResult {
  content: string;
  capped: boolean;
  originalChars: number;
}

/**
 * Wraps `truncate` to additionally report whether truncation happened
 * and the pre-truncation length. Callers (write sites for PKB seed and
 * mra-results) use the metadata to write `message.capped` audit
 * events without re-measuring.
 */
export function capMessageContent(content: string, limit: number): CapResult {
  if (content.length <= limit) {
    return { content, capped: false, originalChars: content.length };
  }
  return {
    content: truncate(content, limit),
    capped: true,
    originalChars: content.length,
  };
}

/**
 * Build a one-shot seed message containing PKB content for the
 * configured ingest spec. Returns undefined when no PKB is found
 * (mra workspace missing, no repos with PKB, etc.).
 *
 * Pattern: same as the case command's buildSeedMessage — we package
 * the four base docs per repo so the model can ground answers in real
 * module names / API endpoints from turn one.
 *
 * `mraWorkspace` overrides the cwd-walk in mraDoctor; pass through
 * `cfg.mraWorkspace` so the seed can be built from any launch
 * directory.
 */
export function buildIngestSeed(
  ingestSpec: string,
  mraWorkspace?: string,
): string | undefined {
  const doctor = mraDoctor({ workspace: mraWorkspace });
  if (!doctor.ok) return undefined;
  const tail = ingestSpec.startsWith("mra:") ? ingestSpec.slice(4) : ingestSpec;
  const repos =
    tail === "--all"
      ? listMraWorkspaceReposWithPkb(doctor.workspace!)
      : tail
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean);

  const blocks: string[] = [];
  for (const repo of repos) {
    const repoPath = resolveMraRepo(doctor.workspace!, repo);
    if (!repoPath) continue;
    const docs = loadPkbBase(repoPath);
    if (docs.length === 0) continue;
    blocks.push(
      [
        `## repo: ${repo}`,
        ...docs.map(
          (d) => `### ${d.name}\n\n\`\`\`markdown\n${d.content.trim()}\n\`\`\``,
        ),
      ].join("\n\n"),
    );
  }
  if (blocks.length === 0) return undefined;
  return [
    "我先把 workspace 的 PKB context 給你（後續對話請用這些事實作答；缺的就老實說沒有，不要編造）：",
    "",
    blocks.join("\n\n---\n\n"),
  ].join("\n");
}

/**
 * Compose the user-message that flows back to the LLM after `mra ask`
 * failed. Includes stderr / stdout excerpts when present so the model
 * can apologise with a specific cause ("mra reported missing PKB",
 * "mra timed out") instead of a generic "unknown" — which is all
 * Node's err.message gives us by default.
 */
export function buildMraFailureMessage(
  repo: string,
  result: { stdout: string; stderr: string; reason?: string },
): string {
  const lines = [`\`mra ask ${repo}\` 失敗：${result.reason ?? "unknown"}`];
  if (result.stderr.trim()) {
    lines.push(
      "",
      "```mra-stderr",
      truncate(result.stderr.trim(), 4_000),
      "```",
    );
  }
  if (result.stdout.trim()) {
    lines.push(
      "",
      "```mra-partial-stdout",
      truncate(result.stdout.trim(), 2_000),
      "```",
    );
  }
  lines.push(
    "",
    "請以目前已載入的 PKB context 直接回答；若 PKB 也不足，請老實說「目前資料不夠」並引用上面 stderr 提到的具體原因（如有），不要編造。",
  );
  return lines.join("\n");
}

/**
 * Compose the user-message that flows back to the LLM after `mra ask`
 * succeeded — wraps stdout in a fenced `mra-result` block with
 * priority instructions for synthesis.
 */
export function buildMraSuccessMessage(repo: string, stdout: string): string {
  return [
    `這是 \`mra ask ${repo}\` 的回傳結果（請依此 synthesise 最終答案；若這份結果不足，可再 emit 一次 mra-ask，但仍以 PKB + 這份結果優先）：`,
    "",
    "```mra-result",
    truncate(stdout.trim(), 24_000),
    "```",
  ].join("\n");
}

// ─────────────────── session pruning (v0.8.1, #18) ──────────────────────

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Soft cap for `session.approxTokens` before pruning kicks in.
 * v0.11.1: lowered default from 60_000 → 25_000. The 60k figure
 * assumed ~70% of a 90k DM-context budget and ignored the host
 * config that `claude-agent-sdk` inherits when it spawns the local
 * `claude` CLI. 25k leaves explicit headroom for system prompt +
 * retrieval prefix + SDK-inherited host context + new turn + reply.
 * Override with `PMK_MAX_SESSION_TOKENS=…` per host.
 */
export const MAX_SESSION_TOKENS = parsePositiveIntEnv(
  "PMK_MAX_SESSION_TOKENS",
  25_000,
);

/**
 * Maximum chars for the PKB seed message pushed at the start of a
 * fresh session. Defaults to 12_000 — generous enough for a multi-
 * repo summary, tight enough that the seed cannot single-handedly
 * exhaust the model's input window. Override with `PMK_SEED_CAP=…`
 * per host.
 */
export const SEED_CAP = parsePositiveIntEnv("PMK_SEED_CAP", 12_000);

/**
 * Maximum chars for `mra-ask` stdout pushed into session history.
 * Wired into `buildMraSuccessMessage` by a follow-up task (T9 of the
 * v0.11.1 hardening plan); until then the function still uses its
 * pre-existing hard-coded 24_000. Setting `PMK_MRA_RESULT_CAP` only
 * takes effect once that wiring lands.
 */
export const MRA_RESULT_CAP = parsePositiveIntEnv(
  "PMK_MRA_RESULT_CAP",
  16_000,
);

/** How many recent (user, assistant) pairs to always keep across a prune. */
export const KEEP_RECENT_TURNS = 10;

interface SessionLike {
  messages: ChatMessage[];
  approxTokens: number;
}

/**
 * The PKB seed pair, when present, is always the first two messages
 * of a session and starts with this exact string (set by
 * `runFreeChatTurn`). Detecting by content prefix avoids storing a
 * "this is the seed pair" flag on every session.
 */
const PKB_SEED_PREFIX = "我先把 workspace 的 PKB context 給你";

/**
 * Estimate token count for a primary message-array, optionally adding
 * the cost of an `extra` array (e.g. `retrievalPrefix` content that is
 * sent to the model on the next call but not stored in
 * `session.messages`). Uses the same ~3.5 chars-per-token heuristic.
 */
export function approxTokensFor(
  messages: ChatMessage[],
  extra: ChatMessage[] = [],
): number {
  let total = 0;
  for (const m of messages) total += m.content.length;
  for (const m of extra) total += m.content.length;
  return Math.ceil(total / 3.5);
}

export interface PruneResult {
  pruned: boolean;
  /** Number of `(user, assistant)` pairs we dropped. */
  droppedPairs: number;
  /** Token tally after pruning (matches `session.approxTokens`). */
  tokensAfter: number;
}

export interface PruneOpts {
  /** Messages sent on next call but not in session.messages (e.g. retrievalPrefix). */
  extra?: ChatMessage[];
  /** New user turn that will be appended to the call payload. */
  newUser?: string;
}

/**
 * If a session is approaching context-window saturation, drop the
 * oldest non-seed turns to bring it back under cap. Always preserves:
 *
 *   1. The PKB seed pair (first two messages, when content matches
 *      `PKB_SEED_PREFIX`)
 *   2. The most recent `KEEP_RECENT_TURNS` * 2 messages
 *
 * Drops everything in between and inserts a synthetic user marker so
 * the model knows there was earlier history. Idempotent — running
 * again on an already-pruned session is a no-op.
 *
 * The function MUTATES the passed session and returns a small report
 * for the caller to log. Caller is responsible for calling
 * `saveSession()` afterward so the pruned state hits disk.
 */
export function pruneSessionIfNeeded(
  session: SessionLike,
  opts: PruneOpts = {},
): PruneResult {
  const extras: ChatMessage[] = [
    ...(opts.extra ?? []),
    ...(opts.newUser ? [{ role: "user" as const, content: opts.newUser }] : []),
  ];
  // Recompute INCLUDING extras so we don't undercount the next call.
  session.approxTokens = approxTokensFor(session.messages, extras);

  if (session.approxTokens <= MAX_SESSION_TOKENS) {
    return {
      pruned: false,
      droppedPairs: 0,
      tokensAfter: session.approxTokens,
    };
  }

  const msgs = session.messages;
  const hasPkbSeed =
    msgs.length >= 2 &&
    msgs[0].role === "user" &&
    msgs[0].content.startsWith(PKB_SEED_PREFIX) &&
    msgs[1].role === "assistant";

  // Already-pruned sessions have a marker right after the seed; bail
  // out to keep this idempotent.
  const seedEnd = hasPkbSeed ? 2 : 0;
  if (
    msgs[seedEnd]?.role === "user" &&
    msgs[seedEnd]?.content.startsWith("(此處省略") &&
    msgs.length - seedEnd - 1 <= KEEP_RECENT_TURNS * 2
  ) {
    // We've already pruned and not enough new turns have accumulated
    // to need another pass. Recompute tokens just in case — include
    // extras so the post-call invariant is consistent across all
    // return paths (downstream callers see a single, comparable value).
    session.approxTokens = approxTokensFor(msgs, extras);
    return {
      pruned: false,
      droppedPairs: 0,
      tokensAfter: session.approxTokens,
    };
  }

  const keepFromEnd = KEEP_RECENT_TURNS * 2;
  // Nothing to prune if we're already at/below the keep window after
  // the seed. (Edge case: a single huge message can put us over cap
  // without there being anything to drop.)
  if (msgs.length - seedEnd <= keepFromEnd) {
    return {
      pruned: false,
      droppedPairs: 0,
      tokensAfter: session.approxTokens,
    };
  }

  const seedSlice = hasPkbSeed ? msgs.slice(0, 2) : [];
  const recent = msgs.slice(-keepFromEnd);
  const dropped = msgs.length - seedEnd - keepFromEnd;
  const droppedPairs = Math.floor(dropped / 2);

  const marker: ChatMessage = {
    role: "user",
    content: `(此處省略 ${droppedPairs} 輪較舊的對話以節省 context — 完整歷史仍在 host 的 session.json)`,
  };

  session.messages = [...seedSlice, marker, ...recent];
  session.approxTokens = approxTokensFor(session.messages, extras);
  return {
    pruned: true,
    droppedPairs,
    tokensAfter: session.approxTokens,
  };
}
