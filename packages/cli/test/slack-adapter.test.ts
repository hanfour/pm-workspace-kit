/**
 * v0.13 SlackGateway integration harness coverage.
 *
 * Each test drives the full event-handler graph (`handleMessage`,
 * `handleAppMention`, `handleReactionAdded`, `handleSlashCommand`)
 * through the constructor-injected fake transport — so we exercise
 * the orchestration that pre-v0.13 had no automated coverage.
 *
 * Tests redirect `$HOME` to a tmp dir via `buildHarness()`, so all
 * `~/.pmk/` writes (sessions, atoms, events log, admin log) stay
 * isolated and disposable. `afterEach` restores `$HOME`.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import {
  appMentionPayload,
  buildHarness,
  dmMessagePayload,
  type Harness,
} from "./harness/slack-fakes";

describe("SlackAdapter integration: DM happy-path", () => {
  let h: Harness;

  beforeEach(() => {
    h = buildHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("DM ask → fake LLM reply → final answer updates the placeholder", async () => {
    const reply = "Sure — that's a great question. Here is a plain answer.";
    h.llm.script(reply);

    await h.adapter.start();

    await h.socket.emit(
      "message",
      dmMessagePayload({
        user: "U-USER",
        channel: "D-USER-DM",
        text: "What is this PRD about?",
      }),
    );

    assert.equal(h.llm.calls.length, 1, "LLM should be called once");

    const placeholders = h.web.posted.filter((p) =>
      p.text?.includes("thinking"),
    );
    assert.equal(
      placeholders.length,
      1,
      "exactly one 'thinking…' placeholder should be posted",
    );
    assert.equal(placeholders[0].channel, "D-USER-DM");

    assert.equal(
      h.web.updated.length,
      1,
      "final reply should be one chat.update against the placeholder",
    );
    assert.equal(h.web.updated[0].channel, "D-USER-DM");
    assert.match(
      h.web.updated[0].text ?? "",
      /great question/,
      "update text should carry the LLM reply",
    );
  });

  it("non-DM channel message is ignored (app_mention covers that path)", async () => {
    h.llm.script("should never be called");
    await h.adapter.start();

    await h.socket.emit(
      "message",
      dmMessagePayload({
        user: "U-USER",
        channel: "C-CHANNEL",
        text: "hello bot",
      }),
    );

    assert.equal(h.llm.calls.length, 0, "channel-scope message must skip LLM");
    assert.equal(h.web.updated.length, 0, "no update should fire");
  });

  it("blocklisted user gets the rejection notice and no LLM call", async () => {
    h = buildHarness({ config: { blocklist: ["U-BAD"] } });
    h.llm.script("should never be called");
    await h.adapter.start();

    await h.socket.emit(
      "message",
      dmMessagePayload({
        user: "U-BAD",
        channel: "D-BAD-DM",
        text: "let me in",
      }),
    );

    assert.equal(h.llm.calls.length, 0);
    const posts = h.web.postsTo("D-BAD-DM");
    assert.equal(posts.length, 1);
    assert.match(posts[0].text ?? "", /封鎖名單/);
  });
});

describe("SlackAdapter integration: mra-ask escalate round", () => {
  let h: Harness;

  beforeEach(() => {
    h = buildHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("LLM emits mra-ask → runMraAsk called → synthesise round produces visible reply", async () => {
    // First LLM call: tells the gateway to delegate to mra ask.
    // Second LLM call: synthesises a final user-facing answer that
    // references the mra subprocess output.
    h.llm.script(
      "preamble talking about the repo.\n" +
        "```mra-ask\n" +
        "repo: erp\n" +
        "question: where is sales_performances defined?\n" +
        "```",
      "The `sales_performances` scope lives in `models/order.rb:42`. Here is the breakdown…",
    );
    h.mra.scriptAsk({
      ok: true,
      stdout: "scope :sales_performances defined in models/order.rb:42",
      stderr: "",
      attempts: 1,
    });

    await h.adapter.start();

    await h.socket.emit(
      "message",
      dmMessagePayload({
        user: "U-PM",
        channel: "D-PM-DM",
        text: "where is sales_performances defined?",
      }),
    );

    assert.equal(h.llm.calls.length, 2, "first-call + synthesise = 2 LLM calls");
    assert.equal(h.mra.askCalls.length, 1, "mra ask invoked exactly once");
    assert.equal(h.mra.askCalls[0].repo, "erp");
    assert.match(h.mra.askCalls[0].question, /sales_performances/);
    assert.equal(h.mra.askCalls[0].cwd, "/fake/workspace");

    // Placeholder + progress-update + final update all target the
    // same channel; the latest update text carries the synthesised
    // answer with the machine-readable `mra-ask` block stripped.
    assert.ok(h.web.updated.length >= 1, "at least one chat.update should fire");
    const finalText = h.web.updated[h.web.updated.length - 1].text ?? "";
    assert.match(finalText, /models\/order\.rb:42/);
    assert.doesNotMatch(finalText, /```mra-ask/);
  });

  it("mraDoctor failure surfaces as synthetic mra failure to the LLM (no askCall)", async () => {
    h.mra.doctorResponse = {
      ok: false,
      reason: "configured mraWorkspace stale; no .collab/repos.json",
    };
    h.llm.script(
      "preamble.\n```mra-ask\nrepo: erp\nquestion: where is X?\n```",
      "Sorry, can't reach mra workspace right now — best-effort answer based on PKB.",
    );

    await h.adapter.start();
    await h.socket.emit(
      "message",
      dmMessagePayload({
        user: "U-PM",
        channel: "D-PM-DM",
        text: "where is X?",
      }),
    );

    assert.equal(h.mra.askCalls.length, 0, "doctor short-circuits before runAsk");
    assert.equal(
      h.llm.calls.length,
      2,
      "synthesise still runs with a synthetic mra-failed result",
    );
    const finalText = h.web.updated[h.web.updated.length - 1].text ?? "";
    assert.match(finalText, /best-effort/);
  });

  it("runMraAsk failure surfaces via buildMraFailureMessage into synthesise", async () => {
    h.llm.script(
      "preamble.\n```mra-ask\nrepo: erp\nquestion: where is X?\n```",
      "mra returned no relevant code; falling back to PKB summary.",
    );
    h.mra.scriptAsk({
      ok: false,
      stdout: "",
      stderr: "mra: repo `erp` not found in workspace",
      reason: "exit 1",
      attempts: 2,
    });

    await h.adapter.start();
    await h.socket.emit(
      "message",
      dmMessagePayload({
        user: "U-PM",
        channel: "D-PM-DM",
        text: "where is X?",
      }),
    );

    assert.equal(h.mra.askCalls.length, 1);
    assert.equal(h.llm.calls.length, 2, "synthesise still runs after mra failure");
    const finalText = h.web.updated[h.web.updated.length - 1].text ?? "";
    assert.match(finalText, /PKB summary/);
  });
});
