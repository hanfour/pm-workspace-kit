import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  approxTokensFor,
  capMessageContent,
  MAX_SESSION_TOKENS,
  SEED_CAP,
  MRA_RESULT_CAP,
  pruneSessionIfNeeded,
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

describe("approxTokensFor", () => {
  it("sums primary message content / 3.5", () => {
    assert.equal(approxTokensFor([{ role: "user", content: "x".repeat(35) }]), 10);
  });
  it("includes extra in total", () => {
    const got = approxTokensFor(
      [{ role: "user", content: "x".repeat(35) }],
      [{ role: "user", content: "y".repeat(35) }],
    );
    assert.equal(got, 20);
  });
  it("backward-compatible: omitted extra ≡ []", () => {
    const a = approxTokensFor([{ role: "user", content: "ab" }]);
    const b = approxTokensFor([{ role: "user", content: "ab" }], []);
    assert.equal(a, b);
  });
});

describe("pruneSessionIfNeeded with opts", () => {
  it("recomputes approxTokens including extra+newUser", () => {
    const session = {
      messages: [
        { role: "user" as const, content: "Q" },
        { role: "assistant" as const, content: "A" },
      ],
      approxTokens: 0,
    };
    pruneSessionIfNeeded(session, {
      extra: [{ role: "user", content: "x".repeat(7000) }],
      newUser: "y".repeat(7000),
    });
    assert.ok(session.approxTokens > 3000);
  });
  it("backward-compatible: omitted opts behaves like before", () => {
    const session = {
      messages: [
        { role: "user" as const, content: "hi" },
        { role: "assistant" as const, content: "ok" },
      ],
      approxTokens: 0,
    };
    const r = pruneSessionIfNeeded(session);
    assert.equal(r.pruned, false);
  });
});
