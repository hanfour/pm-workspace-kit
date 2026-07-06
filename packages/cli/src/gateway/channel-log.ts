/**
 * Append-only channel message log (v0.13).
 *
 * Replaces the v0.7 `chat-session.json` read-modify-write model in
 * the channel free-chat path. The old shared `ChannelChatSession`
 * raced when multiple users @-mentioned the bot in parallel (which
 * the v0.13 per-user-per-channel inFlight lock now allows) — two
 * users would load the same in-memory snapshot, each push their own
 * turn, and the second `saveChannelChatSession` overwrote the
 * first's turn on disk.
 *
 * This module switches to a per-line JSONL log appended with
 * `fs.appendFileSync` (one POSIX syscall ≡ atomic write). Multiple
 * concurrent writers all land; ordering by timestamp + write-order.
 * No read-modify-write means no last-write-wins data loss.
 *
 * Layout (mirrors the channel session-store layout):
 *
 *   ~/.pmk/gateway/slack/channels/<channelId>/messages.jsonl
 *   ~/.pmk/gateway/slack/channels/<channelId>/threads/<ts>/messages.jsonl
 *
 * One line per turn-message. Reading is a streaming scan (skip
 * malformed lines); writing is append-only with `mkdir -p` so each
 * channel/thread provisions on first use.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ChatMessage } from "@pmk/shared";
import { assertSafeSegment } from "./session-store";

const PLATFORM_SLACK = "slack";

function gatewaySlackChannelsDir(): string {
  return path.join(os.homedir(), ".pmk", "gateway", PLATFORM_SLACK, "channels");
}

function channelDir(channelId: string, threadTs?: string): string {
  // channelId/threadTs originate from an external Slack payload — guard every
  // path segment (parity with session-store / issue-candidate) so a forged event
  // can't escape ~/.pmk/gateway/ via `/`, `..`, or a control char.
  const base = path.join(gatewaySlackChannelsDir(), assertSafeSegment(channelId, "channelId"));
  return threadTs ? path.join(base, "threads", assertSafeSegment(threadTs, "threadTs")) : base;
}

function channelLogPath(channelId: string, threadTs?: string): string {
  return path.join(channelDir(channelId, threadTs), "messages.jsonl");
}

/** Legacy `chat-session.json` location — same dir as `messages.jsonl`. */
function legacyChatSessionPath(channelId: string, threadTs?: string): string {
  return path.join(channelDir(channelId, threadTs), "chat-session.json");
}

/**
 * One entry in the channel log. User entries carry `userId` so the
 * bot can attribute turns in multi-user channels; assistant entries
 * never need attribution (the bot is implicit).
 *
 * `content` is the user-visible text the legacy session stored —
 * after `stripCaseUpdateBlock` / `stripMraAskBlock` / `stripEscalateBlock`
 * for assistant entries. We deliberately do NOT persist the full
 * directive-bearing LLM output (none of the legacy session.json
 * persisted it either; follow-up turns work on the stripped text).
 */
export interface ChannelLogEntry {
  /** ISO-8601 UTC timestamp. */
  ts: string;
  role: "user" | "assistant";
  /** Present on user entries; absent on assistant + seed-context entries. */
  userId?: string;
  content: string;
}

/**
 * Append one or more entries atomically. Each `appendFileSync` is a
 * single POSIX syscall so two parallel callers can safely append at
 * the same time without read-modify-write races.
 */
export function appendChannelTurns(
  channelId: string,
  threadTs: string | undefined,
  entries: ChannelLogEntry[],
): void {
  if (entries.length === 0) return;
  const dir = channelDir(channelId, threadTs);
  fs.mkdirSync(dir, { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.appendFileSync(channelLogPath(channelId, threadTs), lines, {
    encoding: "utf8",
  });
}

export interface LoadChannelTurnsOptions {
  /** Return at most this many most-recent entries (after migration). */
  limit?: number;
  /** Drop entries older than `Date.now() - sinceMs`. */
  sinceMs?: number;
}

/**
 * Read all entries for a channel (or channel-thread). Triggers a
 * one-time migration from the legacy `chat-session.json` on first
 * call: messages get converted to JSONL entries, the old file is
 * removed, and the converted entries flow through normally on this
 * read. Subsequent reads are migration-free.
 *
 * Malformed lines are skipped silently — a single bad write
 * mustn't poison the audit / replay.
 */
export function loadChannelTurns(
  channelId: string,
  threadTs?: string,
  opts: LoadChannelTurnsOptions = {},
): ChannelLogEntry[] {
  migrateLegacyChatSessionIfPresent(channelId, threadTs);
  const file = channelLogPath(channelId, threadTs);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  const entries: ChannelLogEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ChannelLogEntry;
      if (
        parsed &&
        (parsed.role === "user" || parsed.role === "assistant") &&
        typeof parsed.content === "string" &&
        typeof parsed.ts === "string"
      ) {
        entries.push(parsed);
      }
    } catch {
      /* skip malformed lines */
    }
  }
  let result = entries;
  if (opts.sinceMs !== undefined) {
    const cutoff = Date.now() - opts.sinceMs;
    result = result.filter((e) => {
      const t = Date.parse(e.ts);
      return Number.isFinite(t) && t >= cutoff;
    });
  }
  if (opts.limit !== undefined && opts.limit >= 0 && result.length > opts.limit) {
    result = result.slice(result.length - opts.limit);
  }
  return result;
}

/**
 * Convert log entries to the `ChatMessage[]` shape the LLM call
 * expects. Drops the `userId` and `ts` metadata — the legacy session
 * never had them, so behaviour is unchanged for the model.
 *
 * (A future iteration could prepend `[<userId>]` attribution to user
 * entries so the LLM can distinguish speakers in multi-user channels;
 * holding that change for a follow-up because it shifts prompt
 * semantics.)
 */
export function entriesToMessages(entries: ChannelLogEntry[]): ChatMessage[] {
  return entries.map((e) => ({ role: e.role, content: e.content }));
}

/**
 * One-time conversion of an existing `chat-session.json` to JSONL.
 * Idempotent: a no-op when the JSONL already exists or the legacy
 * file is absent. Uses each message's index as an epoch-offset
 * timestamp so chronological ordering is preserved relative to new
 * entries that get appended afterwards.
 */
function migrateLegacyChatSessionIfPresent(
  channelId: string,
  threadTs?: string,
): void {
  const newFile = channelLogPath(channelId, threadTs);
  if (fs.existsSync(newFile)) return;
  const oldFile = legacyChatSessionPath(channelId, threadTs);
  if (!fs.existsSync(oldFile)) return;
  try {
    const raw = fs.readFileSync(oldFile, "utf8");
    const parsed = JSON.parse(raw) as {
      messages?: Array<{ role: string; content: string }>;
      lastActiveAt?: number;
    };
    if (!Array.isArray(parsed.messages)) return;
    // Synthesise timestamps. Without per-message timestamps in the
    // legacy file, we space them out by 1s each so chronological
    // ordering relative to newly-appended entries stays sensible.
    const baseMs = typeof parsed.lastActiveAt === "number"
      ? parsed.lastActiveAt - parsed.messages.length * 1000
      : 0;
    const entries: ChannelLogEntry[] = parsed.messages
      .filter(
        (m): m is { role: "user" | "assistant"; content: string } =>
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string",
      )
      .map((m, i) => ({
        ts: new Date(baseMs + i * 1000).toISOString(),
        role: m.role,
        content: m.content,
      }));
    if (entries.length > 0) {
      appendChannelTurns(channelId, threadTs, entries);
    }
    fs.unlinkSync(oldFile);
  } catch {
    /* best-effort; leave the legacy file in place if conversion fails */
  }
}
