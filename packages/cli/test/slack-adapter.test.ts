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
