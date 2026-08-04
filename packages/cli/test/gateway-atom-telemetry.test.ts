import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WebClient } from "@slack/web-api";
import type { EscalationCoordinator } from "../src/gateway/slack/escalation";
import { GATEWAY_CONFIG_VERSION, type GatewayConfig } from "../src/gateway/config";

// Never point HOME back at the operator's home. Test files run in separate
// processes, so restoring buys nothing — and it opens a window that has
// already caused an outage: a cancelled test's abandoned continuation resumes
// AFTER afterEach, sees the real HOME, and writes to the live ~/.pmk. On
// 2026-08-04 that overwrote the gateway config with test fixtures and took
// the bot down. ORIG_HOME is a throwaway directory, never the real one.
const ORIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-safe-home-"));
process.env.HOME = ORIG_HOME;

describe("atom-telemetry sidecar", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-atom-tel-"));
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env.HOME = ORIG_HOME;
  });

  it("missing sidecar reads as empty", async () => {
    const { loadTelemetry } = await import("../src/gateway/atom-telemetry");
    const store = loadTelemetry();
    assert.deepEqual(store, { version: 1, atoms: {}, questionedKeys: [] });
  });

  it("bumpReuse increments count and sets lastRetrievedAt", async () => {
    const { bumpReuse, loadTelemetry } = await import("../src/gateway/atom-telemetry");
    bumpReuse(["a1", "a2"], "2026-05-29T00:00:00.000Z");
    bumpReuse(["a1"], "2026-05-29T01:00:00.000Z");
    const s = loadTelemetry();
    assert.equal(s.atoms.a1.reuseCount, 2);
    assert.equal(s.atoms.a1.lastRetrievedAt, "2026-05-29T01:00:00.000Z");
    assert.equal(s.atoms.a2.reuseCount, 1);
  });

  it("bumpReuse with no ids is a no-op", async () => {
    const { bumpReuse, loadTelemetry } = await import("../src/gateway/atom-telemetry");
    bumpReuse([], "2026-05-29T00:00:00.000Z");
    assert.deepEqual(loadTelemetry().atoms, {});
  });

  it("bumpQuestioned increments and dedupes by key", async () => {
    const { bumpQuestioned, loadTelemetry } = await import("../src/gateway/atom-telemetry");
    bumpQuestioned(["a1"], "reaction:C:T:U:-1", "2026-05-29T00:00:00.000Z");
    bumpQuestioned(["a1"], "reaction:C:T:U:-1", "2026-05-29T02:00:00.000Z"); // dup → ignored
    const s = loadTelemetry();
    assert.equal(s.atoms.a1.questionedCount, 1);
    assert.equal(s.atoms.a1.lastQuestionedAt, "2026-05-29T00:00:00.000Z");
    assert.equal(s.questionedKeys.length, 1);
  });

  it("bumpQuestioned with a new key bumps again", async () => {
    const { bumpQuestioned, loadTelemetry } = await import("../src/gateway/atom-telemetry");
    bumpQuestioned(["a1"], "reaction:C:T:U:-1", "2026-05-29T00:00:00.000Z");
    bumpQuestioned(["a1"], "escalate:C:T:R", "2026-05-29T03:00:00.000Z");
    assert.equal(loadTelemetry().atoms.a1.questionedCount, 2);
  });

  it("questionedKeys is bounded to the most recent cap", async () => {
    const { bumpQuestioned, loadTelemetry } = await import("../src/gateway/atom-telemetry");
    for (let i = 0; i < 2050; i++) {
      bumpQuestioned(["a1"], `escalate:C:T:r${i}`, "2026-05-29T00:00:00.000Z");
    }
    const s = loadTelemetry();
    assert.equal(s.questionedKeys.length, 2000);
    // newest retained, oldest evicted
    assert.ok(s.questionedKeys.includes("escalate:C:T:r2049"));
    assert.ok(!s.questionedKeys.includes("escalate:C:T:r0"));
    // count still reflects every distinct event
    assert.equal(s.atoms.a1.questionedCount, 2050);
  });
});

describe("free-chat-turn telemetry wiring", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-fct-tel-"));
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env.HOME = ORIG_HOME;
  });

  it("bumpReuse is called after a successful LLM reply that injected an atom", async () => {
    const { saveAtom } = await import("../src/gateway/knowledge");
    const { loadTelemetry } = await import("../src/gateway/atom-telemetry");
    const { FreeChatTurnRunner } = await import("../src/gateway/slack/free-chat-turn");

    // Seed one approved atom whose question contains distinctive keywords.
    // saveAtom returns the file path (string); we don't need it here —
    // the atom id is known at the call-site and asserted directly below.
    saveAtom({
      id: "test-atom-reuse-001",
      createdAt: Date.now(),
      scope: "general",
      question: "What is the deploy workflow for xyzfoobardeploy?",
      answer: "Run deploy.sh from root.",
      tags: ["deploy", "xyzfoobardeploy"],
      source: { threadKey: "C-TEST:1000000.000001", contributorUserId: "U-IT" },
      status: "approved",
    });

    // Minimal web fake: postMessage returns a ts, update is a no-op.
    // conversations.info/members are needed by makeAtomAccessChecker (Task 10):
    // return is_private:false so the test channel is treated as public and the
    // atom passes the access filter (preserving pre-Task-10 telemetry behaviour).
    let postCount = 0;
    const fakeWeb = {
      chat: {
        postMessage: async (_args: unknown) => {
          postCount++;
          return { ok: true, ts: `1700000000.${String(postCount).padStart(6, "0")}` };
        },
        update: async (_args: unknown) => ({ ok: true }),
      },
      conversations: {
        info: async () => ({ channel: { is_channel: true, is_private: false } }),
        members: async () => ({ members: [] }),
      },
    } as unknown as WebClient;

    // Minimal LLM fake: returns a plain answer
    const fakeLlm = {
      name: "anthropic-api" as const,
      displayName: "fake",
      chat: async () => "Here is the deploy workflow explanation.",
    };

    // Minimal EscalationCoordinator fake
    const fakeEscalation = {
      escalate: async () => undefined,
    } as unknown as EscalationCoordinator;

    const defaultConfig: GatewayConfig = {
      version: GATEWAY_CONFIG_VERSION,
      admins: [],
      blocklist: [],
      audience: { default: "tech", users: {}, channels: {} },
      escalation: { default: [], repos: {} },
      slack: { appToken: "xapp-test", botToken: "xoxb-test", botUserId: "UBOT", workspaceName: "test" },
    };

    const runner = new FreeChatTurnRunner({
      web: fakeWeb,
      config: defaultConfig,
      onLog: () => undefined,
      llm: fakeLlm,
      mraDoctor: () => ({ ok: false, reason: "no mra in test" }),
      runMraAsk: async () => { throw new Error("should not be called"); },
      escalation: fakeEscalation,
    });

    const session = { messages: [], turns: 0, approxTokens: 0 };
    await runner.run({
      channelId: "D-TEST",
      threadTs: "1700000100.000100",
      text: "What is the deploy workflow for xyzfoobardeploy?",
      userId: "U-USER",
      session,
      saveSession: () => undefined,
    });

    const tel = loadTelemetry();
    assert.equal(
      tel.atoms["test-atom-reuse-001"]?.reuseCount,
      1,
      "reuseCount should be 1 after a successful turn that injected the atom",
    );
  });

  it("bumpQuestioned is called with escalate: key when the model escalates after injecting an atom", async () => {
    const { saveAtom } = await import("../src/gateway/knowledge");
    const { loadTelemetry } = await import("../src/gateway/atom-telemetry");
    const { FreeChatTurnRunner } = await import("../src/gateway/slack/free-chat-turn");

    // Seed one approved atom
    saveAtom({
      id: "test-atom-questioned-001",
      createdAt: Date.now(),
      scope: "general",
      question: "What is the xyzescalatetest build process?",
      answer: "Run build.sh.",
      tags: ["build", "xyzescalatetest"],
      source: { threadKey: "C-TEST2:1000000.000001", contributorUserId: "U-IT" },
      status: "approved",
    });

    let postCount = 0;
    const fakeWeb = {
      chat: {
        postMessage: async (_args: unknown) => {
          postCount++;
          return { ok: true, ts: `1700000000.${String(postCount).padStart(6, "0")}` };
        },
        update: async (_args: unknown) => ({ ok: true }),
      },
      conversations: {
        info: async () => ({ channel: { is_channel: true, is_private: false } }),
        members: async () => ({ members: [] }),
      },
    } as unknown as WebClient;

    // LLM returns an escalate directive
    const fakeLlm = {
      name: "anthropic-api" as const,
      displayName: "fake",
      chat: async () =>
        "I don't know the full answer.\n```escalate\nquestion: What is the xyzescalatetest build process?\nreason: not in PKB\n```",
    };

    let escalateCalled = false;
    const fakeEscalation = {
      escalate: async () => { escalateCalled = true; },
    } as unknown as EscalationCoordinator;

    const defaultConfig: GatewayConfig = {
      version: GATEWAY_CONFIG_VERSION,
      admins: [],
      blocklist: [],
      audience: { default: "tech", users: {}, channels: {} },
      escalation: { default: [], repos: {} },
      slack: { appToken: "xapp-test", botToken: "xoxb-test", botUserId: "UBOT", workspaceName: "test" },
    };

    const runner = new FreeChatTurnRunner({
      web: fakeWeb,
      config: defaultConfig,
      onLog: () => undefined,
      llm: fakeLlm,
      mraDoctor: () => ({ ok: false, reason: "no mra in test" }),
      runMraAsk: async () => { throw new Error("should not be called"); },
      escalation: fakeEscalation,
    });

    const session = { messages: [], turns: 0, approxTokens: 0 };
    await runner.run({
      channelId: "C-CHAN",
      threadTs: "1700000200.000200",
      text: "What is the xyzescalatetest build process?",
      userId: "U-USER",
      session,
      saveSession: () => undefined,
    });

    assert.ok(escalateCalled, "escalation should have been triggered");
    const tel = loadTelemetry();
    assert.equal(
      tel.atoms["test-atom-questioned-001"]?.questionedCount,
      1,
      "questionedCount should be 1 after escalation with injected atom",
    );
    const escKey = tel.questionedKeys.find((k) => k.startsWith("escalate:C-CHAN:1700000200.000200:"));
    assert.ok(escKey !== undefined, "questionedKeys should contain an escalate:-prefixed key for this turn");
  });
});

describe("atoms telemetry report", () => {
  it("buildAtomTelemetryReport sorts weakest-first and flags dead-weight/load-bearing", async () => {
    const { buildAtomTelemetryReport } = await import("../src/commands/gateway");
    const atoms = [
      { id: "hot", question: "q1", scope: "s", createdAt: 0, answer: "", tags: [], source: { threadKey: "", contributorUserId: "" } },
      { id: "cold", question: "q2", scope: "s", createdAt: 0, answer: "", tags: [], source: { threadKey: "", contributorUserId: "" } },
    ];
    const store = {
      version: 1 as const,
      atoms: {
        hot: { reuseCount: 9, lastRetrievedAt: "2026-05-29T00:00:00.000Z", questionedCount: 0, lastQuestionedAt: null },
      },
      questionedKeys: [],
    };
    const rows = buildAtomTelemetryReport(atoms as any, store);
    assert.equal(rows[0].id, "cold");
    assert.equal(rows[0].deadWeight, true);
    assert.equal(rows[0].createdAt, 0);
    assert.equal(rows[1].id, "hot");
    assert.equal(rows[1].loadBearing, true);
    assert.equal(rows[1].createdAt, 0);
  });
});
