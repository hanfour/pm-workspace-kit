import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

describe("manifest", () => {
  it("requests files:read so the bot can download attachments", () => {
    const p = path.join(__dirname, "..", "src", "gateway", "slack", "manifest.template.json");
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.ok(m.oauth_config.scopes.bot.includes("files:read"));
  });
});
