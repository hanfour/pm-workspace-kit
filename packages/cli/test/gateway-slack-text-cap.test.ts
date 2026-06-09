import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { wrapWebClientWithTextCap } from "../src/gateway/slack/text-cap-wrapper";

function fakeWeb() {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return {
    calls,
    chat: {
      postMessage: async (p: Record<string, unknown>) => { calls.push(["postMessage", p]); return { ok: true }; },
      update: async (p: Record<string, unknown>) => { calls.push(["update", p]); return { ok: true }; },
      postEphemeral: async (p: Record<string, unknown>) => { calls.push(["postEphemeral", p]); return { ok: true }; },
    },
    conversations: {
      history: async (p: Record<string, unknown>) => { calls.push(["history", p]); return { ok: true, messages: [] }; },
    },
  };
}

describe("wrapWebClientWithTextCap", () => {
  it("caps an over-long chat.postMessage text below Slack's 40000 hard limit", async () => {
    const web = fakeWeb();
    const wrapped = wrapWebClientWithTextCap(web as never);
    const huge = "x".repeat(50_000);
    await wrapped.chat.postMessage({ channel: "C1", text: huge } as never);
    const sent = web.calls[0][1].text as string;
    assert.ok(sent.length < 40_000, `capped text should be < 40000, was ${sent.length}`);
    assert.match(sent, /truncated by pmk/);
  });

  it("caps chat.update too, preserving other fields, WITHOUT mutating the caller's payload", async () => {
    const web = fakeWeb();
    const wrapped = wrapWebClientWithTextCap(web as never);
    const payload = { channel: "C1", ts: "1.2", text: "y".repeat(45_000) };
    await wrapped.chat.update(payload as never);
    const sent = web.calls[0][1];
    assert.ok((sent.text as string).length < 40_000);
    assert.equal(sent.channel, "C1");
    assert.equal(sent.ts, "1.2");
    // immutability: the original payload object must be untouched
    assert.equal(payload.text.length, 45_000);
  });

  it("leaves a short text unchanged and passes read methods through", async () => {
    const web = fakeWeb();
    const wrapped = wrapWebClientWithTextCap(web as never);
    await wrapped.chat.postMessage({ channel: "C1", text: "hi" } as never);
    assert.equal(web.calls[0][1].text, "hi");
    await wrapped.conversations.history({ channel: "C1" } as never);
    assert.equal(web.calls[1][0], "history");
  });
});
