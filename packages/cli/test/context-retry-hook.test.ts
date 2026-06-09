import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ORIG_HOME = process.env.HOME;

describe("chatWithContextRetry onBeforeRetry", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-hook-test-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
    else delete process.env.HOME;
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
