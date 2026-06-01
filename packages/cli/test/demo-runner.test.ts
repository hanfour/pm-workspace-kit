import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import type { StoredGatewayEvent } from "../src/gateway/events";
import type { RunDemoDeps } from "../src/gateway/demo/demo-runner";

describe("isFinalAnswerText", () => {
  it("rejects placeholder, progress lines, empty; accepts a real answer", async () => {
    const { isFinalAnswerText } = await import("../src/gateway/demo/acme-ads-script");
    assert.equal(isFinalAnswerText(":hourglass_flowing_sand: thinking…"), false);
    assert.equal(isFinalAnswerText("[ask] searching repos…"), false);
    assert.equal(isFinalAnswerText("[1;37m[ask][0m running"), false);
    assert.equal(isFinalAnswerText("   "), false);
    assert.equal(isFinalAnswerText("AdFormat 是廣告版型，placement 是版位。"), true);
  });
});

describe("ACME_ADS_DEMO_SCRIPT", () => {
  it("has 5 questions", async () => {
    const { ACME_ADS_DEMO_SCRIPT } = await import("../src/gateway/demo/acme-ads-script");
    assert.equal(ACME_ADS_DEMO_SCRIPT.length, 5);
  });
});

describe("matchTurnEvent", () => {
  it("matches the turn.processed for this channel/actor after postedAt; threadTs for non-DM", async () => {
    const { matchTurnEvent } = await import("../src/gateway/demo/demo-runner");
    const events: StoredGatewayEvent[] = [
      { at: "2026-06-01T00:00:01.000Z", type: "turn.processed", actor: "U_OTHER", audience: "biz", hadMraAsk: false, atomsInjected: 0, channelId: "C1", threadTs: "100.1", replyTs: "100.2" },
      { at: "2026-06-01T00:00:02.500Z", type: "turn.processed", actor: "U_DEMO", audience: "biz", hadMraAsk: false, atomsInjected: 0, channelId: "C1", threadTs: "200.1" },
      { at: "2026-06-01T00:00:03.000Z", type: "turn.processed", actor: "U_DEMO", audience: "biz", hadMraAsk: false, atomsInjected: 1, channelId: "C1", threadTs: "200.1", replyTs: "200.2" },
    ] as StoredGatewayEvent[];
    const m = matchTurnEvent(events, { channelId: "C1", actor: "U_DEMO", sincePostedAtMs: Date.parse("2026-06-01T00:00:02.000Z"), threadTs: "200.1" });
    assert.equal(m?.replyTs, "200.2");
    assert.equal(matchTurnEvent(events, { channelId: "C1", actor: "U_DEMO", sincePostedAtMs: 0, threadTs: "999" }), null);
    assert.equal(matchTurnEvent(events, { channelId: "C1", actor: "U_DEMO", sincePostedAtMs: 0 })?.replyTs, "200.2");
  });
});

describe("runDemo", () => {
  const script = ["q1", "q2"] as const;
  function fakes(over: Partial<RunDemoDeps> = {}) {
    const posted: string[] = [];
    return {
      posted,
      deps: {
        script, channelId: "C1", isDm: true, botUserId: "BOT", dryRun: false, timeoutMs: 1000,
        post: async (text: string) => { posted.push(text); return { ts: `ts-${posted.length}` }; },
        awaitTurn: async (postedTs: string) => ({ replyTs: `reply-${postedTs}` }),
        readReply: async (_parentTs: string, replyTs: string) => `answer for ${replyTs}`,
        now: () => 1000,
        ...over,
      },
    };
  }

  it("happy path: posts each question, reads each answer into the transcript", async () => {
    const { runDemo } = await import("../src/gateway/demo/demo-runner");
    const { deps, posted } = fakes();
    const t = await runDemo(deps);
    assert.deepEqual(posted, ["q1", "q2"]);
    assert.equal(t.turns.length, 2);
    assert.equal(t.turns[0].answer, "answer for reply-ts-1");
    assert.equal(t.turns[0].posted, true);
  });

  it("non-DM prefixes each question with the bot mention", async () => {
    const { runDemo } = await import("../src/gateway/demo/demo-runner");
    const { deps, posted } = fakes({ isDm: false });
    await runDemo(deps);
    assert.equal(posted[0], "<@BOT> q1");
  });

  it("dry-run posts nothing and records the to-be-posted text", async () => {
    const { runDemo } = await import("../src/gateway/demo/demo-runner");
    const { deps, posted } = fakes({ isDm: false, dryRun: true });
    const t = await runDemo(deps);
    assert.equal(posted.length, 0);
    assert.equal(t.turns[0].posted, false);
    assert.equal(t.turns[0].question, "<@BOT> q1");
  });

  it("timeout: awaitTurn null → no-reply sentinel, run continues", async () => {
    const { runDemo } = await import("../src/gateway/demo/demo-runner");
    const { deps } = fakes({ awaitTurn: async () => null });
    const t = await runDemo(deps);
    assert.match(t.turns[0].answer ?? "", /no reply within/);
    assert.equal(t.turns[0].posted, true);
    assert.equal(t.turns[0].replyTs, null);
    assert.equal(t.turns.length, 2);
  });
});

describe("pickReplyText", () => {
  it("returns the text of the message with the matching ts, else empty", async () => {
    const { pickReplyText } = await import("../src/commands/demo");
    const msgs = [{ ts: "P", text: "parent (the question)" }, { ts: "R", text: "the bot answer" }];
    assert.equal(pickReplyText(msgs, "R"), "the bot answer");
    assert.equal(pickReplyText(msgs, "MISSING"), "");
  });
});

describe("renderTranscript", () => {
  it("renders each Q with its answer and the no-reply sentinel", async () => {
    const { renderTranscript } = await import("../src/commands/demo");
    const text = renderTranscript({
      channelId: "C1", dryRun: false,
      turns: [
        { question: "q1", posted: true, answer: "a1", replyTs: "r1" },
        { question: "q2", posted: true, answer: "(no reply within 120s)", replyTs: null },
      ],
    });
    assert.match(text, /q1/);
    assert.match(text, /a1/);
    assert.match(text, /no reply within 120s/);
  });
});
