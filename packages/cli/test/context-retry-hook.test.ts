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

describe("chatWithContextRetry onBeforeRetry", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-hook-test-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env.HOME = ORIG_HOME;
  });

  it("fires the hook after the first context failure, before the retry build", async () => {
    const { chatWithContextRetry } = await import(
      "../src/gateway/slack/context-retry"
    );
    const { PmkContextTooLongError } = await import("../src/llm/claude-agent");

    const order: string[] = [];
    let call = 0;
    const llm = {
      chat: async () => {
        call++;
        if (call === 1) throw new PmkContextTooLongError(new Error("too long"));
        return "ok";
      },
    } as any;
    const session = {
      messages: [{ role: "user" as const, content: "hi" }],
      approxTokens: 1,
    };
    const res = await chatWithContextRetry({
      llm,
      systemPrompt: "s",
      buildMessages: () => {
        order.push("build");
        return session.messages;
      },
      session,
      actor: "U1",
      retrievalAtoms: 0,
      phase: "first-call" as const,
      onBeforeRetry: () => order.push("hook"),
    });
    assert.equal(res.ok, true);
    assert.deepEqual(order, ["build", "hook", "build"]);
  });
});
