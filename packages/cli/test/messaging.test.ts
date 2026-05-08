import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  approxTokensFor,
  capMessageContent,
  forcePruneToMinimum,
  MAX_SESSION_TOKENS,
  SEED_CAP,
  MRA_RESULT_CAP,
  pruneSessionIfNeeded,
} from "../src/gateway/messaging";

const SEED = "我先把 workspace 的 PKB context 給你 xxx";

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

describe("messaging cap defaults (v0.12.0)", () => {
  it("MAX_SESSION_TOKENS default is 60_000", () => {
    assert.equal(MAX_SESSION_TOKENS, 60_000);
  });
  it("SEED_CAP default is 30_000", () => {
    assert.equal(SEED_CAP, 30_000);
  });
  it("MRA_RESULT_CAP default is 40_000", () => {
    assert.equal(MRA_RESULT_CAP, 40_000);
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

describe("forcePruneToMinimum", () => {
  it("keeps seed pair + last pair, returns droppedPairs", () => {
    const session = {
      messages: [
        { role: "user" as const, content: SEED }, { role: "assistant" as const, content: "ok" },
        { role: "user" as const, content: "Q1" }, { role: "assistant" as const, content: "A1" },
        { role: "user" as const, content: "Q2" }, { role: "assistant" as const, content: "A2" },
        { role: "user" as const, content: "Q3" }, { role: "assistant" as const, content: "A3" },
      ],
      approxTokens: 0,
    };
    const dropped = forcePruneToMinimum(session);
    assert.equal(dropped, 2);
    assert.equal(session.messages.length, 4);
    assert.ok(session.messages[0].content.startsWith("我先把"));
    assert.equal(session.messages[3].content, "A3");
  });
  it("works without seed pair", () => {
    const session = {
      messages: [
        { role: "user" as const, content: "Q1" }, { role: "assistant" as const, content: "A1" },
        { role: "user" as const, content: "Q2" }, { role: "assistant" as const, content: "A2" },
      ],
      approxTokens: 0,
    };
    assert.equal(forcePruneToMinimum(session), 1);
    assert.equal(session.messages[0].content, "Q2");
  });
  it("idempotent on already-minimal sessions", () => {
    const session = {
      messages: [
        { role: "user" as const, content: SEED }, { role: "assistant" as const, content: "ok" },
        { role: "user" as const, content: "Q" }, { role: "assistant" as const, content: "A" },
      ],
      approxTokens: 0,
    };
    assert.equal(forcePruneToMinimum(session), 0);
    assert.equal(session.messages.length, 4);
  });
});
