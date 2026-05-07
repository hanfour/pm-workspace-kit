import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  capMessageContent,
  MAX_SESSION_TOKENS,
  SEED_CAP,
  MRA_RESULT_CAP,
} from "../src/gateway/messaging";

describe("capMessageContent", () => {
  it("returns content unchanged when within limit", () => {
    const r = capMessageContent("hello", 10);
    assert.deepEqual(r, { content: "hello", capped: false, originalChars: 5 });
  });
  it("truncates over-limit content and reports originalChars", () => {
    const r = capMessageContent("x".repeat(100), 20);
    assert.equal(r.capped, true);
    assert.equal(r.originalChars, 100);
    assert.ok(r.content.startsWith("x".repeat(20)));
    assert.ok(r.content.includes("truncated"));
  });
  it("boundary: length === limit returns unchanged", () => {
    assert.equal(capMessageContent("12345", 5).capped, false);
  });
  it("counts chars not bytes (multibyte safe)", () => {
    assert.equal(capMessageContent("你好你好你好", 10).originalChars, 6);
  });
});

describe("messaging cap defaults", () => {
  it("MAX_SESSION_TOKENS default is 25_000 (v0.11.1)", () => {
    assert.equal(MAX_SESSION_TOKENS, 25_000);
  });
  it("SEED_CAP default is 12_000", () => {
    assert.equal(SEED_CAP, 12_000);
  });
  it("MRA_RESULT_CAP default is 16_000", () => {
    assert.equal(MRA_RESULT_CAP, 16_000);
  });
});
