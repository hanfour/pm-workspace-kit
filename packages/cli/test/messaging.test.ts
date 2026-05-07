import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { capMessageContent } from "../src/gateway/messaging";

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
