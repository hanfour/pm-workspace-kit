import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Never point HOME back at the operator's home. Test files run in separate
// processes, so restoring buys nothing — and it opens a window that has
// already caused an outage: a cancelled test's abandoned continuation resumes
// AFTER afterEach, sees the real HOME, and writes to the live ~/.pmk. On
// 2026-08-04 that overwrote the gateway config with test fixtures and took
// the bot down. ORIG_HOME is a throwaway directory, never the real one.
const ORIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-safe-home-"));
process.env.HOME = ORIG_HOME;

describe("chatWithContextRetry (T11)", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-retry-test-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env.HOME = ORIG_HOME;
  });

  it("happy path: returns full + empty scissorsPrefix", async () => {
    const { chatWithContextRetry } = await import(
      "../src/gateway/slack/context-retry"
    );
    const llm = { chat: async () => "hello" };
    const session = { messages: [], approxTokens: 0 };
    const r = await chatWithContextRetry({
      llm,
      systemPrompt: "sys",
      buildMessages: () => [{ role: "user", content: "hi" }],
      session,
      actor: "Uabc",
      retrievalAtoms: 0,
      phase: "first-call",
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.full, "hello");
      assert.equal(r.scissorsPrefix, "");
    }
  });

  it("non-context error returns {ok:false, kind:'other'}", async () => {
    const { chatWithContextRetry } = await import(
      "../src/gateway/slack/context-retry"
    );
    const orig = new Error("rate limit");
    const llm = {
      chat: async () => {
        throw orig;
      },
    };
    const session = { messages: [], approxTokens: 0 };
    const r = await chatWithContextRetry({
      llm,
      systemPrompt: "sys",
      buildMessages: () => [{ role: "user", content: "hi" }],
      session,
      actor: "Uabc",
      retrievalAtoms: 0,
      phase: "first-call",
    });
    assert.equal(r.ok, false);
    if (!r.ok && r.kind === "other") {
      assert.equal(r.error, orig);
    } else {
      assert.fail("expected kind=other");
    }
  });

  it("context error → force-prune → retry success → scissorsPrefix populated + events written", async () => {
    const { chatWithContextRetry } = await import(
      "../src/gateway/slack/context-retry"
    );
    const { PmkContextTooLongError } = await import(
      "../src/llm/claude-agent"
    );
    const { readGatewayEvents } = await import("../src/gateway/events");

    let calls = 0;
    const llm = {
      chat: async () => {
        calls++;
        if (calls === 1)
          throw new PmkContextTooLongError(new Error("msg_too_long"));
        return "after retry";
      },
    };
    // PKB seed prefix from messaging.ts; force-prune detects this exact
    // string at messages[0].content.startsWith(...).
    const SEED = "我先把 workspace 的 PKB context 給你 …";
    const session = {
      messages: [
        { role: "user" as const, content: SEED },
        { role: "assistant" as const, content: "ok" },
        { role: "user" as const, content: "Q1" },
        { role: "assistant" as const, content: "A1" },
        { role: "user" as const, content: "Q2" },
        { role: "assistant" as const, content: "A2" },
      ],
      approxTokens: 12345,
    };
    const r = await chatWithContextRetry({
      llm,
      systemPrompt: "sys",
      buildMessages: () => session.messages,
      session,
      actor: "Uabc",
      retrievalAtoms: 2,
      phase: "first-call",
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.full, "after retry");
      assert.match(
        r.scissorsPrefix,
        /^:scissors: 對話過長，已自動裁掉 \d+ 輪舊訊息\n\n$/,
      );
    }
    assert.equal(calls, 2);
    // Force-prune kept seed pair (2 msgs) + last user/assistant pair (2 msgs).
    assert.equal(session.messages.length, 4);
    // Events landed.
    const events = readGatewayEvents({}).map((e) => e.type);
    assert.ok(events.includes("context.exceeded"));
    assert.ok(events.includes("context.force-pruned"));
  });

  it("context error → force-prune → retry also fails → {ok:false, kind:'context'}", async () => {
    const { chatWithContextRetry } = await import(
      "../src/gateway/slack/context-retry"
    );
    const { PmkContextTooLongError } = await import(
      "../src/llm/claude-agent"
    );
    const llm = {
      chat: async () => {
        throw new PmkContextTooLongError(new Error("msg_too_long"));
      },
    };
    const session = {
      messages: [
        { role: "user" as const, content: "Q1" },
        { role: "assistant" as const, content: "A1" },
        { role: "user" as const, content: "Q2" },
        { role: "assistant" as const, content: "A2" },
      ],
      approxTokens: 5_000,
    };
    const r = await chatWithContextRetry({
      llm,
      systemPrompt: "sys",
      buildMessages: () => session.messages,
      session,
      actor: "Uabc",
      retrievalAtoms: 0,
      phase: "first-call",
    });
    assert.equal(r.ok, false);
    if (!r.ok && r.kind === "context") {
      assert.ok(r.firstError instanceof PmkContextTooLongError);
      assert.ok(r.secondError instanceof PmkContextTooLongError);
    } else {
      assert.fail("expected kind=context");
    }
  });

  it("phase=synthesise: emits context.exceeded with phase='synthesise' (T12)", async () => {
    const { chatWithContextRetry } = await import(
      "../src/gateway/slack/context-retry"
    );
    const { PmkContextTooLongError } = await import(
      "../src/llm/claude-agent"
    );
    const { readGatewayEvents } = await import("../src/gateway/events");
    let calls = 0;
    const llm = {
      chat: async () => {
        calls++;
        if (calls === 1)
          throw new PmkContextTooLongError(new Error("msg_too_long"));
        return "synth ok";
      },
    };
    const SEED = "我先把 workspace 的 PKB context 給你 …";
    const session = {
      messages: [
        { role: "user" as const, content: SEED },
        { role: "assistant" as const, content: "ok" },
        { role: "user" as const, content: "Q1" },
        { role: "assistant" as const, content: "A1" },
        { role: "user" as const, content: "Q2" },
        { role: "assistant" as const, content: "A2" },
      ],
      approxTokens: 8_000,
    };
    const r = await chatWithContextRetry({
      llm,
      systemPrompt: "sys",
      buildMessages: () => session.messages,
      session,
      actor: "Uabc",
      retrievalAtoms: 1,
      phase: "synthesise",
    });
    assert.equal(r.ok, true);
    const events = readGatewayEvents({});
    const exc = events.find((e) => e.type === "context.exceeded");
    assert.ok(exc, "expected context.exceeded event");
    if (exc && exc.type === "context.exceeded") {
      assert.equal(exc.phase, "synthesise");
    }
  });

  it("dropped=0 (degenerate session): scissorsPrefix is empty even on retry success", async () => {
    const { chatWithContextRetry } = await import(
      "../src/gateway/slack/context-retry"
    );
    const { PmkContextTooLongError } = await import(
      "../src/llm/claude-agent"
    );
    let calls = 0;
    const llm = {
      chat: async () => {
        calls++;
        if (calls === 1) throw new PmkContextTooLongError(new Error("msg_too_long"));
        return "after retry";
      },
    };
    // Session too short for forcePruneToMinimum to drop anything
    // (only one user/assistant pair, no seed) — should still retry
    // but suppress the misleading "已裁掉 0 輪" marker.
    const session = {
      messages: [
        { role: "user" as const, content: "Q" },
        { role: "assistant" as const, content: "A" },
      ],
      approxTokens: 1_000,
    };
    const r = await chatWithContextRetry({
      llm,
      systemPrompt: "sys",
      buildMessages: () => session.messages,
      session,
      actor: "Uabc",
      retrievalAtoms: 0,
      phase: "first-call",
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.full, "after retry");
      assert.equal(r.scissorsPrefix, "");
    }
  });
});
