import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { sanitizeProgressLine } from "../src/gateway/slack/progress";

describe("sanitizeProgressLine (#22 / v0.10)", () => {
  it("strips ANSI SGR escape sequences from mra progress output", () => {
    const raw = "\x1b[1;37m[ask]\x1b[0m querying: erp";
    assert.equal(sanitizeProgressLine(raw), "[ask] querying: erp");
  });

  it("strips multi-arg ANSI SGR sequences (e.g. bold + color)", () => {
    const raw = "\x1b[1;31;47m[err]\x1b[0;22m something";
    assert.equal(sanitizeProgressLine(raw), "[err] something");
  });

  it("strips Slack mrkdwn meta so progress can't render as formatting", () => {
    assert.equal(sanitizeProgressLine("`code` *bold* _it_"), "code bold it");
    assert.equal(
      sanitizeProgressLine("hi <@U123> <https://x|y>"),
      "hi @U123 https://x|y",
    );
  });

  it("caps length at 200 chars by default", () => {
    const long = "x".repeat(500);
    assert.equal(sanitizeProgressLine(long).length, 200);
  });

  it("respects custom maxLen", () => {
    const long = "x".repeat(500);
    assert.equal(sanitizeProgressLine(long, 50).length, 50);
  });

  it("handles combined ANSI + mrkdwn + length cap", () => {
    const raw = "\x1b[31m[ask]\x1b[0m " + "*".repeat(300);
    const out = sanitizeProgressLine(raw);
    assert.ok(!out.includes("\x1b"));
    assert.ok(!out.includes("*"));
    assert.ok(out.length <= 200);
  });

  it("leaves unrelated characters intact", () => {
    const raw = "[ask] PKB loaded — 42 docs (querying: erp/auth)";
    assert.equal(
      sanitizeProgressLine(raw),
      "[ask] PKB loaded — 42 docs (querying: erp/auth)",
    );
  });
});
