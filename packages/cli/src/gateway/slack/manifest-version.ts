// Version metadata + expected-scope mirror for the Slack app manifest.
//
// Kept OUT of manifest.template.json on purpose: Slack's manifest schema
// may reject unknown fields, so embedding our own version key inside
// the JSON risks upload failure. PR-58 review R1-M2 / R2-M1.
//
// The M2 `doctor-checks/manifest-alignment.ts` check imports the
// `expected*` functions from here and compares them against what the
// host's installed Slack app actually declares; any drift surfaces as
// a doctor FAIL with the missing-scope list as a hint.

export const MANIFEST_VERSION = "2026-05";

const BOT_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "files:read",
  "im:history",
  "im:read",
  "im:write",
  "users:read",
  "reactions:read",
  // The review flow re-reads a thread's root message (conversations.history)
  // for `rerun`, `retry`, and the `:cr:` / `:a:` reaction paths. `im:history`
  // only covers DMs; without these two, every one of those commands fails in a
  // channel with missing_scope. Added 2026-08-14 after finance-system#378,
  // where `rerun` reported the thread as having no review because the read
  // itself was refused.
  "channels:history",
  "groups:history",
] as const;

const BOT_EVENTS = [
  "message.im",
  "app_mention",
  "reaction_added",
] as const;

const APP_LEVEL_TOKEN_SCOPES = ["connections:write"] as const;

export type BotScope = (typeof BOT_SCOPES)[number];
export type BotEvent = (typeof BOT_EVENTS)[number];
export type AppLevelTokenScope = (typeof APP_LEVEL_TOKEN_SCOPES)[number];

export function expectedScopes(): readonly BotScope[] {
  return BOT_SCOPES;
}

export function expectedEvents(): readonly BotEvent[] {
  return BOT_EVENTS;
}

export function expectedAppLevelTokenScopes(): readonly AppLevelTokenScope[] {
  return APP_LEVEL_TOKEN_SCOPES;
}
