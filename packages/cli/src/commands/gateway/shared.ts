import chalk from "chalk";
import { AUDIENCE_KEYS, type AudienceKey } from "@pmk/shared";
import { println } from "../../io";

export function isAudienceKey(s: string): s is AudienceKey {
  return (AUDIENCE_KEYS as readonly string[]).includes(s);
}

/**
 * Slack workspace user IDs are `U` (regular) or `W` (enterprise grid)
 * followed by uppercase alphanum. We reject anything else with a hint
 * so hosts catch typos like `@hanfour` early.
 */
export const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{2,}$/;

export function ensureValidSlackUserId(userId: string): boolean {
  if (SLACK_USER_ID_RE.test(userId)) return true;
  println(
    chalk.red(
      `invalid Slack user ID '${userId}'. Expected format e.g. U0B05XYZ — open Slack profile → 'Copy member ID'.`,
    ),
  );
  return false;
}

/**
 * Slack channel IDs (#23): `C` (public), `G` (private), or `D` (DM)
 * followed by uppercase alphanum. DM IDs are accepted because the
 * channel-default mechanism still works there even though
 * per-channel overrides for DMs are degenerate (per-user already
 * covers the same ground).
 */
export const SLACK_CHANNEL_ID_RE = /^[CGD][A-Z0-9]{2,}$/;

export function ensureValidSlackChannelId(channelId: string): boolean {
  if (SLACK_CHANNEL_ID_RE.test(channelId)) return true;
  println(
    chalk.red(
      `invalid Slack channel ID '${channelId}'. Expected format e.g. C0AVD1XD946 — channel name → 'View channel details' → 'Copy channel ID'.`,
    ),
  );
  return false;
}

export const EXAMPLE_TIERS = ["biz", "pm"] as const;
export type ExampleTier = (typeof EXAMPLE_TIERS)[number];
export function isExampleTier(t: string): t is ExampleTier {
  return (EXAMPLE_TIERS as readonly string[]).includes(t);
}
