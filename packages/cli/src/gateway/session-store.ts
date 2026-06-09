import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatMessage } from "@pmk/shared";
import { gatewayDir } from "./config";
import { isRecord, readJsonFile, writeJsonFile } from "./json-store";

/**
 * Where Slack-user-scoped state lives.
 *
 *   ~/.pmk/gateway/slack/users/<userId>/session.json           ← main DM
 *   ~/.pmk/gateway/slack/users/<userId>/threads/<ts>/session.json
 *   ~/.pmk/gateway/slack/users/<userId>/cases/<name>.json
 *
 * Channel-scoped state mirrors that under .../channels/<channelId>/.
 *
 * Each session.json holds the full ChatMessage history for that
 * conversation. "main" = top-level DM / channel chat (no Slack thread).
 * `threads/<ts>/` = a specific Slack thread; sessions are isolated per
 * thread so context from thread A doesn't leak into thread B.
 *
 * Cases are owned per-user; v0.7.0 doesn't implement cross-user case
 * visibility (use channel cases for that).
 */

const PLATFORM_SLACK = "slack";

/**
 * Slack-derived IDs (user/channel/thread_ts) become on-disk path
 * segments. Slack never emits path separators in these, but the values
 * originate from an external payload, so we never trust them blindly:
 * a `/`, `\`, `..`, or control char would let a crafted/forged event
 * escape `~/.pmk/gateway/`. Reject anything that isn't a flat segment.
 */
export function assertSafeSegment(value: string, kind: string): string {
  if (
    !value ||
    value === "." ||
    value === ".." ||
    /[/\\\0]/.test(value) ||
    value.includes("..")
  ) {
    throw new Error(`gateway: unsafe ${kind} segment: ${JSON.stringify(value)}`);
  }
  return value;
}

function userDir(slackUserId: string, threadTs?: string): string {
  const base = path.join(
    gatewayDir(),
    PLATFORM_SLACK,
    "users",
    assertSafeSegment(slackUserId, "userId"),
  );
  return threadTs
    ? path.join(base, "threads", assertSafeSegment(threadTs, "threadTs"))
    : base;
}

function channelDir(slackChannelId: string, threadTs?: string): string {
  const base = path.join(
    gatewayDir(),
    PLATFORM_SLACK,
    "channels",
    assertSafeSegment(slackChannelId, "channelId"),
  );
  return threadTs
    ? path.join(base, "threads", assertSafeSegment(threadTs, "threadTs"))
    : base;
}

/**
 * Channel meta lives at the channel root regardless of thread —
 * activeCase, lastActiveAt are channel-wide, not thread-scoped.
 */
function channelRootDir(slackChannelId: string): string {
  return path.join(
    gatewayDir(),
    PLATFORM_SLACK,
    "channels",
    assertSafeSegment(slackChannelId, "channelId"),
  );
}

export interface UserSession {
  userId: string;
  /** Slack handle / display name; populated when known. */
  displayName?: string;
  messages: ChatMessage[];
  /** When the user last interacted with the bot (ms epoch). */
  lastActiveAt: number;
  /** Approx token tally — for `pmk gateway stats`. */
  approxTokens: number;
  /** Number of turns. */
  turns: number;
}

export interface ChannelMeta {
  channelId: string;
  /** Currently-active case name in this channel, if any. */
  activeCase?: string;
  lastActiveAt: number;
}

/* v0.13: the `ChannelChatSession` type + `loadChannelChatSession` /
 * `saveChannelChatSession` helpers that previously lived here are
 * gone. They modelled the channel free-chat history as a single
 * read-modify-write blob (`chat-session.json`) which raced when
 * parallel @-mentions in the same channel both loaded → mutated →
 * saved. Free-chat now uses the append-only `gateway/channel-log.ts`
 * module; on-disk files migrate automatically on first load. */

/**
 * Lenient validators for on-disk state. They check only the
 * load-bearing field (a session's `messages` array) and otherwise tolerate
 * legacy / partially-written files — the loaders back-fill the rest. This
 * deliberately never rejects a real session over a missing numeric field
 * (which would silently wipe a user's history); it only rejects genuinely
 * unusable shapes (non-object, no messages array, unparseable).
 */
const isStoredUserSession = (
  v: unknown,
): v is Partial<UserSession> & { messages: ChatMessage[] } =>
  isRecord(v) && Array.isArray(v.messages);

const isStoredChannelMeta = (v: unknown): v is Partial<ChannelMeta> =>
  isRecord(v);

/** Read + normalise a user session file. undefined when absent/corrupt. */
function readUserSessionFile(
  file: string,
  fallbackUserId: string,
): UserSession | undefined {
  const raw = readJsonFile(file, isStoredUserSession);
  if (!raw) return undefined;
  return {
    userId: typeof raw.userId === "string" ? raw.userId : fallbackUserId,
    displayName: typeof raw.displayName === "string" ? raw.displayName : undefined,
    messages: raw.messages,
    lastActiveAt: typeof raw.lastActiveAt === "number" ? raw.lastActiveAt : 0,
    approxTokens: typeof raw.approxTokens === "number" ? raw.approxTokens : 0,
    turns: typeof raw.turns === "number" ? raw.turns : 0,
  };
}

export function loadUserSession(
  slackUserId: string,
  threadTs?: string,
): UserSession {
  const file = path.join(userDir(slackUserId, threadTs), "session.json");
  return (
    readUserSessionFile(file, slackUserId) ?? {
      userId: slackUserId,
      messages: [],
      lastActiveAt: 0,
      approxTokens: 0,
      turns: 0,
    }
  );
}

export function saveUserSession(s: UserSession, threadTs?: string): void {
  // Stamp lastActiveAt on a copy — never mutate the caller's object,
  // which may still be in use after the save returns.
  const toSave: UserSession = { ...s, lastActiveAt: Date.now() };
  writeJsonFile(
    path.join(userDir(s.userId, threadTs), "session.json"),
    toSave,
  );
}

export function loadChannelMeta(slackChannelId: string): ChannelMeta {
  const file = path.join(channelRootDir(slackChannelId), "meta.json");
  const raw = readJsonFile(file, isStoredChannelMeta);
  return {
    channelId:
      raw && typeof raw.channelId === "string" ? raw.channelId : slackChannelId,
    activeCase:
      raw && typeof raw.activeCase === "string" ? raw.activeCase : undefined,
    lastActiveAt:
      raw && typeof raw.lastActiveAt === "number" ? raw.lastActiveAt : 0,
  };
}

export function saveChannelMeta(m: ChannelMeta): void {
  // Stamp lastActiveAt on a copy — never mutate the caller's object.
  const toSave: ChannelMeta = { ...m, lastActiveAt: Date.now() };
  writeJsonFile(path.join(channelRootDir(m.channelId), "meta.json"), toSave);
}

/**
 * List Slack user IDs that have interacted within the last N hours.
 * Used to build the broadcast list for offline / online notices.
 */
export function listRecentUsers(hours: number): string[] {
  const dir = path.join(gatewayDir(), PLATFORM_SLACK, "users");
  if (!fs.existsSync(dir)) return [];
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const out: string[] = [];
  for (const id of fs.readdirSync(dir)) {
    const s = readUserSessionFile(path.join(dir, id, "session.json"), id);
    if (s && s.lastActiveAt >= cutoff) out.push(id);
  }
  return out;
}

export function listRecentChannels(hours: number): ChannelMeta[] {
  const dir = path.join(gatewayDir(), PLATFORM_SLACK, "channels");
  if (!fs.existsSync(dir)) return [];
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const out: ChannelMeta[] = [];
  for (const id of fs.readdirSync(dir)) {
    const raw = readJsonFile(
      path.join(dir, id, "meta.json"),
      isStoredChannelMeta,
    );
    if (raw && typeof raw.lastActiveAt === "number" && raw.lastActiveAt >= cutoff) {
      out.push({
        channelId: typeof raw.channelId === "string" ? raw.channelId : id,
        activeCase:
          typeof raw.activeCase === "string" ? raw.activeCase : undefined,
        lastActiveAt: raw.lastActiveAt,
      });
    }
  }
  return out;
}

/**
 * Aggregate stats per user for `pmk gateway stats`.
 */
export function userStats(hours: number): Array<{
  userId: string;
  displayName?: string;
  turns: number;
  approxTokens: number;
  lastActiveAt: number;
}> {
  const dir = path.join(gatewayDir(), PLATFORM_SLACK, "users");
  if (!fs.existsSync(dir)) return [];
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const out: ReturnType<typeof userStats> = [];
  for (const id of fs.readdirSync(dir)) {
    const s = readUserSessionFile(path.join(dir, id, "session.json"), id);
    if (!s || s.lastActiveAt < cutoff) continue;
    out.push({
      userId: s.userId,
      displayName: s.displayName,
      turns: s.turns,
      approxTokens: s.approxTokens,
      lastActiveAt: s.lastActiveAt,
    });
  }
  out.sort((a, b) => b.approxTokens - a.approxTokens);
  return out;
}

/**
 * Path helpers exposed for the case adapter (DM cases per user, shared
 * cases per channel).
 */
export function userCasesDir(slackUserId: string): string {
  return path.join(userDir(slackUserId), "cases");
}

export function channelCasesDir(slackChannelId: string): string {
  return path.join(channelDir(slackChannelId), "cases");
}

/**
 * Per-thread attachments.jsonl path. Flat params (kind/id/threadTs) so
 * session-store.ts does not import the attachments/ module. Reuses
 * userDir/channelDir → assertSafeSegment applies to id and threadTs.
 */
export function attachmentLogPath(
  kind: "dm" | "channel",
  id: string,
  threadTs: string,
): string {
  const dir = kind === "dm" ? userDir(id, threadTs) : channelDir(id, threadTs);
  return path.join(dir, "attachments.jsonl");
}

/**
 * Pending-escalation marker per Slack thread. Set when pmk emits an
 * `escalate` directive; cleared after a registered contributor replies
 * and pmk absorbs the answer. Stored under
 *   ~/.pmk/gateway/slack/escalations/<channelId>__<threadTs>.json
 * (flat path keeps lookup O(1) regardless of channel).
 */
export interface ThreadEscalation {
  channelId: string;
  threadTs: string;
  question: string;
  scope?: string;
  reason?: string;
  pendingSince: number;
  /** Slack user IDs that pmk @-mentioned. */
  mentionedUserIds: string[];
  /** The user who triggered the escalation (will get the synthesised
   * follow-up answer once IT replies). Optional for back-compat with
   * markers written by older builds. */
  askerUserId?: string;
}

function escalationsDir(): string {
  return path.join(gatewayDir(), PLATFORM_SLACK, "escalations");
}

function escalationFile(channelId: string, threadTs: string): string {
  return path.join(
    escalationsDir(),
    `${assertSafeSegment(channelId, "channelId")}__${assertSafeSegment(threadTs, "threadTs")}.json`,
  );
}

/**
 * Validate a stored escalation marker. Requires every field a consumer
 * relies on — notably `mentionedUserIds` (an array), because
 * `maybeAbsorbReply` calls `.includes()` on it; a marker missing it
 * would crash the absorb path, so we'd rather treat it as absent.
 */
const isStoredThreadEscalation = (v: unknown): v is ThreadEscalation =>
  isRecord(v) &&
  typeof v.channelId === "string" &&
  typeof v.threadTs === "string" &&
  typeof v.question === "string" &&
  typeof v.pendingSince === "number" &&
  Array.isArray(v.mentionedUserIds);

export function loadThreadEscalation(
  channelId: string,
  threadTs: string,
): ThreadEscalation | undefined {
  return readJsonFile(
    escalationFile(channelId, threadTs),
    isStoredThreadEscalation,
  );
}

export function saveThreadEscalation(esc: ThreadEscalation): void {
  writeJsonFile(escalationFile(esc.channelId, esc.threadTs), esc);
}

export function clearThreadEscalation(
  channelId: string,
  threadTs: string,
): void {
  const file = escalationFile(channelId, threadTs);
  try {
    fs.unlinkSync(file);
  } catch {
    /* may already be gone */
  }
}

/**
 * Atomically claim a pending-escalation marker. `fs.renameSync` is
 * atomic on POSIX, so when two tagged contributors reply to the same
 * escalated thread at once (different inflight-queue keys → genuinely
 * parallel), only ONE wins the rename — the loser gets ENOENT and bails.
 * This is what stops a duplicate atom being extracted from a single
 * escalation. Returns the marker on a successful claim, or undefined if
 * there's no marker / another caller already claimed it.
 *
 * The claimed marker is consumed (deleted) before returning — claiming
 * is one-shot, mirroring the previous load-then-clear semantics.
 */
export function claimThreadEscalation(
  channelId: string,
  threadTs: string,
): ThreadEscalation | undefined {
  const file = escalationFile(channelId, threadTs);
  const claimed = `${file}.claiming`;
  try {
    fs.renameSync(file, claimed);
  } catch {
    // ENOENT: no marker, or a sibling reply already won the rename.
    return undefined;
  }
  try {
    return readJsonFile(claimed, isStoredThreadEscalation);
  } finally {
    try {
      fs.unlinkSync(claimed);
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * List every escalation marker currently on disk. A marker existing
 * means the thread is still waiting for an IT reply (clearThreadEscalation
 * deletes the file the moment a reply lands and is absorbed). Used by
 * `pmk gateway audit` to count + flag stale pending escalations.
 *
 * Returns parsed markers; corrupt or non-JSON files are skipped.
 */
export function listPendingEscalations(): ThreadEscalation[] {
  const dir = escalationsDir();
  if (!fs.existsSync(dir)) return [];
  const out: ThreadEscalation[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const parsed = readJsonFile(
      path.join(dir, f),
      isStoredThreadEscalation,
    );
    if (parsed) out.push(parsed);
  }
  return out;
}
