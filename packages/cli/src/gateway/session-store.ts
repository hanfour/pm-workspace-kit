import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatMessage } from "@pmk/shared";
import { gatewayDir } from "./config";

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

function userDir(slackUserId: string, threadTs?: string): string {
  const base = path.join(gatewayDir(), PLATFORM_SLACK, "users", slackUserId);
  return threadTs ? path.join(base, "threads", threadTs) : base;
}

function channelDir(slackChannelId: string, threadTs?: string): string {
  const base = path.join(
    gatewayDir(),
    PLATFORM_SLACK,
    "channels",
    slackChannelId,
  );
  return threadTs ? path.join(base, "threads", threadTs) : base;
}

/**
 * Channel meta lives at the channel root regardless of thread —
 * activeCase, lastActiveAt are channel-wide, not thread-scoped.
 */
function channelRootDir(slackChannelId: string): string {
  return path.join(gatewayDir(), PLATFORM_SLACK, "channels", slackChannelId);
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

/**
 * Channel-shared free-chat session. Used when `@pmk` is mentioned in a
 * channel that has no active case — the bot drops into the same
 * PKB-grounded chat mode as DMs, but the message history is shared
 * across everyone in the channel (mirrors how channel cases are
 * shared, not per-user).
 *
 * File: ~/.pmk/gateway/slack/channels/<channelId>/chat-session.json
 */
export interface ChannelChatSession {
  channelId: string;
  messages: ChatMessage[];
  lastActiveAt: number;
  approxTokens: number;
  turns: number;
}

export function loadUserSession(
  slackUserId: string,
  threadTs?: string,
): UserSession {
  const file = path.join(userDir(slackUserId, threadTs), "session.json");
  if (!fs.existsSync(file)) {
    return {
      userId: slackUserId,
      messages: [],
      lastActiveAt: 0,
      approxTokens: 0,
      turns: 0,
    };
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as UserSession;
}

export function saveUserSession(s: UserSession, threadTs?: string): void {
  const dir = userDir(s.userId, threadTs);
  fs.mkdirSync(dir, { recursive: true });
  s.lastActiveAt = Date.now();
  fs.writeFileSync(
    path.join(dir, "session.json"),
    JSON.stringify(s, null, 2),
    "utf8",
  );
}

export function loadChannelChatSession(
  slackChannelId: string,
  threadTs?: string,
): ChannelChatSession {
  const file = path.join(
    channelDir(slackChannelId, threadTs),
    "chat-session.json",
  );
  if (!fs.existsSync(file)) {
    return {
      channelId: slackChannelId,
      messages: [],
      lastActiveAt: 0,
      approxTokens: 0,
      turns: 0,
    };
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as ChannelChatSession;
}

export function saveChannelChatSession(
  s: ChannelChatSession,
  threadTs?: string,
): void {
  const dir = channelDir(s.channelId, threadTs);
  fs.mkdirSync(dir, { recursive: true });
  s.lastActiveAt = Date.now();
  fs.writeFileSync(
    path.join(dir, "chat-session.json"),
    JSON.stringify(s, null, 2),
    "utf8",
  );
}

export function loadChannelMeta(slackChannelId: string): ChannelMeta {
  const file = path.join(channelRootDir(slackChannelId), "meta.json");
  if (!fs.existsSync(file)) {
    return { channelId: slackChannelId, lastActiveAt: 0 };
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as ChannelMeta;
}

export function saveChannelMeta(m: ChannelMeta): void {
  const dir = channelRootDir(m.channelId);
  fs.mkdirSync(dir, { recursive: true });
  m.lastActiveAt = Date.now();
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify(m, null, 2),
    "utf8",
  );
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
    try {
      const s = JSON.parse(
        fs.readFileSync(path.join(dir, id, "session.json"), "utf8"),
      ) as UserSession;
      if (s.lastActiveAt >= cutoff) out.push(id);
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

export function listRecentChannels(hours: number): ChannelMeta[] {
  const dir = path.join(gatewayDir(), PLATFORM_SLACK, "channels");
  if (!fs.existsSync(dir)) return [];
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const out: ChannelMeta[] = [];
  for (const id of fs.readdirSync(dir)) {
    try {
      const m = JSON.parse(
        fs.readFileSync(path.join(dir, id, "meta.json"), "utf8"),
      ) as ChannelMeta;
      if (m.lastActiveAt >= cutoff) out.push(m);
    } catch {
      /* skip */
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
    try {
      const s = JSON.parse(
        fs.readFileSync(path.join(dir, id, "session.json"), "utf8"),
      ) as UserSession;
      if (s.lastActiveAt < cutoff) continue;
      out.push({
        userId: s.userId,
        displayName: s.displayName,
        turns: s.turns,
        approxTokens: s.approxTokens,
        lastActiveAt: s.lastActiveAt,
      });
    } catch {
      /* skip */
    }
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
  return path.join(escalationsDir(), `${channelId}__${threadTs}.json`);
}

export function loadThreadEscalation(
  channelId: string,
  threadTs: string,
): ThreadEscalation | undefined {
  const file = escalationFile(channelId, threadTs);
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as ThreadEscalation;
  } catch {
    return undefined;
  }
}

export function saveThreadEscalation(esc: ThreadEscalation): void {
  fs.mkdirSync(escalationsDir(), { recursive: true });
  fs.writeFileSync(
    escalationFile(esc.channelId, esc.threadTs),
    JSON.stringify(esc, null, 2),
    "utf8",
  );
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
