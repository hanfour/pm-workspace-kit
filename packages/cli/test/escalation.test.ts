import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WebClient } from "@slack/web-api";
import { EscalationCoordinator } from "../src/gateway/slack/escalation";
import {
  claimThreadEscalation,
  loadThreadEscalation,
  saveThreadEscalation,
} from "../src/gateway/session-store";
import { loadAtoms } from "../src/gateway/knowledge";
import { readGatewayEvents } from "../src/gateway/events";
import {
  GATEWAY_CONFIG_VERSION,
  type GatewayConfig,
} from "../src/gateway/config";
import type { LlmProvider } from "../src/llm";

// Never point HOME back at the operator's home. Test files run in separate
// processes, so restoring buys nothing — and it opens a window that has
// already caused an outage: a cancelled test's abandoned continuation resumes
// AFTER afterEach, sees the real HOME, and writes to the live ~/.pmk. On
// 2026-08-04 that overwrote the gateway config with test fixtures and took
// the bot down. ORIG_HOME is a throwaway directory, never the real one.
const ORIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-safe-home-"));
process.env.HOME = ORIG_HOME;

const ATOM_JSON = JSON.stringify({
  question: "where is the campaign budget enforced?",
  summary: "Budget is enforced in CampaignGuard before each spend write.",
  tags: ["budget", "campaign"],
});

/** LLM fake: extractor prompt → atom JSON; anything else → prose. */
function fakeLlm(): LlmProvider {
  return {
    name: "anthropic-api",
    displayName: "fake",
    chat: async (systemPrompt: string) =>
      systemPrompt.includes("knowledge-base curator")
        ? ATOM_JSON
        : "synthesised answer for the asker",
  };
}

/** Web fake recording every postMessage; returns an incrementing ts. */
function fakeWeb(posts: Array<{ text?: string }>): WebClient {
  let n = 0;
  return {
    chat: {
      postMessage: async (args: { text?: string }) => {
        posts.push(args);
        n += 1;
        return { ok: true, ts: `1700000000.${String(n).padStart(6, "0")}` };
      },
      update: async () => ({ ok: true }),
    },
  } as unknown as WebClient;
}

function makeConfig(): GatewayConfig {
  return {
    version: GATEWAY_CONFIG_VERSION,
    admins: [],
    blocklist: [],
    audience: { default: "biz", users: {}, channels: {} },
    escalation: { default: [], repos: {} },
    slack: { appToken: "xapp-test", botToken: "xoxb-test", botUserId: "UBOT" },
  };
}

function makeCoordinator(posts: Array<{ text?: string }>): EscalationCoordinator {
  return new EscalationCoordinator({
    web: fakeWeb(posts),
    config: makeConfig(),
    onLog: () => undefined,
    llm: fakeLlm(),
  });
}

describe("claimThreadEscalation (atomic claim)", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-esc-"));
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env.HOME = ORIG_HOME;
  });

  it("first claim wins, second gets undefined, marker is consumed", () => {
    saveThreadEscalation({
      channelId: "C1",
      threadTs: "ts-1",
      question: "q",
      pendingSince: 1,
      mentionedUserIds: ["U-it"],
      askerUserId: "U-asker",
    });
    const first = claimThreadEscalation("C1", "ts-1");
    assert.ok(first);
    assert.deepEqual(first?.mentionedUserIds, ["U-it"]);
    // Second claim of the same marker finds nothing (rename already won).
    assert.equal(claimThreadEscalation("C1", "ts-1"), undefined);
    // And the marker is gone for ordinary reads too.
    assert.equal(loadThreadEscalation("C1", "ts-1"), undefined);
  });

  it("claiming a non-existent marker returns undefined", () => {
    assert.equal(claimThreadEscalation("C-nope", "ts-x"), undefined);
  });
});

describe("EscalationCoordinator.maybeAbsorbReply", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-esc-"));
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env.HOME = ORIG_HOME;
  });

  it("absorbs a tagged contributor's reply: atom saved, event, asker synthesis", async () => {
    saveThreadEscalation({
      channelId: "C-eng",
      threadTs: "ts-abs",
      question: "where is the campaign budget enforced?",
      scope: "erp",
      pendingSince: 1,
      mentionedUserIds: ["U-it"],
      askerUserId: "U-asker",
    });
    const posts: Array<{ text?: string }> = [];
    const coord = makeCoordinator(posts);

    const absorbed = await coord.maybeAbsorbReply({
      channelId: "C-eng",
      threadTs: "ts-abs",
      contributorUserId: "U-it",
      answerText: "It's enforced in CampaignGuard.",
    });

    assert.equal(absorbed, true);
    const atoms = loadAtoms({ promote: false });
    assert.equal(atoms.length, 1, "exactly one atom absorbed");
    assert.equal(atoms[0].status, "pending");
    assert.equal(atoms[0].answer, "It's enforced in CampaignGuard.");
    // escalate.absorbed audit event recorded.
    const events = readGatewayEvents();
    assert.ok(events.some((e) => e.type === "escalate.absorbed"));
    // The original asker got a synthesised follow-up.
    assert.ok(
      posts.some((p) => p.text?.includes("<@U-asker>")),
      "asker is tagged in a synthesis follow-up",
    );
    // Marker consumed.
    assert.equal(loadThreadEscalation("C-eng", "ts-abs"), undefined);
  });

  it("ignores a reply from a non-tagged teammate (marker preserved)", async () => {
    saveThreadEscalation({
      channelId: "C-eng",
      threadTs: "ts-keep",
      question: "q",
      pendingSince: 1,
      mentionedUserIds: ["U-it"],
      askerUserId: "U-asker",
    });
    const posts: Array<{ text?: string }> = [];
    const coord = makeCoordinator(posts);

    const absorbed = await coord.maybeAbsorbReply({
      channelId: "C-eng",
      threadTs: "ts-keep",
      contributorUserId: "U-random",
      answerText: "drive-by comment",
    });

    assert.equal(absorbed, false);
    assert.equal(loadAtoms({ promote: false }).length, 0);
    // Marker still pending — the real IT contact can still answer later.
    assert.ok(loadThreadEscalation("C-eng", "ts-keep"));
  });

  it("two tagged replies to one thread absorb exactly once (no duplicate atom)", async () => {
    saveThreadEscalation({
      channelId: "C-eng",
      threadTs: "ts-race",
      question: "where is the campaign budget enforced?",
      scope: "erp",
      pendingSince: 1,
      mentionedUserIds: ["U-it1", "U-it2"],
      askerUserId: "U-asker",
    });
    const posts: Array<{ text?: string }> = [];
    const coord = makeCoordinator(posts);

    const [a, b] = await Promise.all([
      coord.maybeAbsorbReply({
        channelId: "C-eng",
        threadTs: "ts-race",
        contributorUserId: "U-it1",
        answerText: "answer one",
      }),
      coord.maybeAbsorbReply({
        channelId: "C-eng",
        threadTs: "ts-race",
        contributorUserId: "U-it2",
        answerText: "answer two",
      }),
    ]);

    // Both report "handled" (one absorbed, one saw the claim already
    // taken) — neither should fall through to a normal LLM turn.
    assert.ok(a || b);
    // The atomic claim guarantees a single absorb regardless of ordering.
    assert.equal(
      loadAtoms({ promote: false }).length,
      1,
      "the marker is claimed once → exactly one atom",
    );
    assert.equal(loadThreadEscalation("C-eng", "ts-race"), undefined);
  });
});
