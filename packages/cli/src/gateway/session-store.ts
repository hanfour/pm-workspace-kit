import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatMessage } from "@pmk/shared";
import { gatewayDir } from "./config";

/**
 * Where Slack-user-scoped state lives.
 *
 *   ~/.pmk/gateway/slack/users/<userId>/session.json
 *   ~/.pmk/gateway/slack/users/<userId>/cases/<name>.json
 *
 * Channel-scoped state mirrors that under .../channels/<channelId>/.
 *
 * Each session.json holds the full ChatMessage history for that user's
 * DM thread with the bot. Cases are owned per-user; v0.7.0 doesn't
 * implement cross-user case visibility (use channel cases for that).
 */

const PLATFORM_SLACK = "slack";

function userDir(slackUserId: string): string {
  return path.join(gatewayDir(), PLATFORM_SLACK, "users", slackUserId);
}

function channelDir(slackChannelId: string): string {
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

export function loadUserSession(slackUserId: string): UserSession {
  const file = path.join(userDir(slackUserId), "session.json");
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

export function saveUserSession(s: UserSession): void {
  const dir = userDir(s.userId);
  fs.mkdirSync(dir, { recursive: true });
  s.lastActiveAt = Date.now();
  fs.writeFileSync(
    path.join(dir, "session.json"),
    JSON.stringify(s, null, 2),
    "utf8",
  );
}

export function loadChannelMeta(slackChannelId: string): ChannelMeta {
  const file = path.join(channelDir(slackChannelId), "meta.json");
  if (!fs.existsSync(file)) {
    return { channelId: slackChannelId, lastActiveAt: 0 };
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as ChannelMeta;
}

export function saveChannelMeta(m: ChannelMeta): void {
  const dir = channelDir(m.channelId);
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
