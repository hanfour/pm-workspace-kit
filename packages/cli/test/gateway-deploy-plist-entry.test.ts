import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { buildPlist } from "../src/commands/gateway/service";
import { plistEntryPoint } from "../src/gateway/deploy/plist-entry";

describe("plistEntryPoint", () => {
  it("returns undefined for undefined input", () => {
    assert.equal(plistEntryPoint(undefined), undefined);
  });

  it("returns undefined without ProgramArguments", () => {
    assert.equal(plistEntryPoint("<plist><dict><string>/entry.js</string></dict></plist>"), undefined);
  });

  it("round-trips an entry containing ampersands and quotes", () => {
    const distEntry = '/Users/a&b "x"/.pmk/releases/current/packages/cli/dist/index.js';
    const xml = buildPlist({ nodePath: "/usr/bin/node", distEntry, home: "/Users/x", workingDir: "/ws" });
    assert.equal(plistEntryPoint(xml), distEntry);
  });

  it("decodes angle brackets and decodes ampersands last", () => {
    const xml = '<key>ProgramArguments</key><array><string>node</string><string>&lt;x&gt;/&amp;lt;</string></array>';
    assert.equal(plistEntryPoint(xml), "<x>/&lt;");
  });
});
