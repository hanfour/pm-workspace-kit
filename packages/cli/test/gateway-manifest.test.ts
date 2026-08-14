import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import manifest from "../src/gateway/slack/manifest.template.json";
import {
  MANIFEST_VERSION,
  expectedScopes,
  expectedEvents,
} from "../src/gateway/slack/manifest-version";

// Authoritative scope/event list. If you change this, update both
// manifest.template.json AND manifest-version.ts to match — the doctor
// check in M2 (manifest-alignment.ts) will compare host-side manifest
// against `expectedScopes()` / `expectedEvents()`.
const REQUIRED_BOT_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "files:read",
  "im:history",
  "im:read",
  "im:write",
  "users:read",
  "reactions:read",
  // Thread-root re-reads (rerun / retry / the :cr: and :a: reaction paths) call
  // conversations.history. `im:history` covers DMs only — these two cover
  // public and private channels. Added 2026-08-14 (finance-system#378).
  "channels:history",
  "groups:history",
] as const;

const REQUIRED_BOT_EVENTS = [
  "message.im",
  "app_mention",
  "reaction_added",
] as const;

describe("gateway slack manifest (FR1)", () => {
  it("enables Socket Mode", () => {
    assert.equal(manifest.settings.socket_mode_enabled, true);
  });

  it("declares every required bot scope", () => {
    const declared = new Set<string>(manifest.oauth_config.scopes.bot);
    for (const scope of REQUIRED_BOT_SCOPES) {
      assert.ok(
        declared.has(scope),
        `missing bot scope in manifest: ${scope}`,
      );
    }
  });

  it("subscribes to every required bot event", () => {
    const declared = new Set<string>(
      manifest.settings.event_subscriptions.bot_events,
    );
    for (const event of REQUIRED_BOT_EVENTS) {
      assert.ok(
        declared.has(event),
        `missing bot event in manifest: ${event}`,
      );
    }
  });

  it("does not declare underscore-prefixed custom fields", () => {
    // Slack manifest schema may reject unknown fields; PR-58 review found
    // (R1-M2) that version metadata belongs in manifest-version.ts, not
    // inside the JSON, to avoid risking upload failure.
    for (const k of Object.keys(manifest)) {
      assert.ok(
        !k.startsWith("_"),
        `unexpected custom field in manifest: ${k}`,
      );
    }
  });
});

describe("gateway manifest-version module (FR1)", () => {
  it("mirrors REQUIRED_BOT_SCOPES via expectedScopes()", () => {
    assert.deepEqual(
      [...expectedScopes()].sort(),
      [...REQUIRED_BOT_SCOPES].sort(),
    );
  });

  it("mirrors REQUIRED_BOT_EVENTS via expectedEvents()", () => {
    assert.deepEqual(
      [...expectedEvents()].sort(),
      [...REQUIRED_BOT_EVENTS].sort(),
    );
  });

  it("exports a non-empty MANIFEST_VERSION", () => {
    assert.equal(typeof MANIFEST_VERSION, "string");
    assert.ok(MANIFEST_VERSION.length > 0);
  });
});
