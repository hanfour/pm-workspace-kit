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
  reactionAddedPayload,
  slashCommandPayload,
  type Harness,
} from "./harness/slack-fakes";
import {
  channelCasesDir,
  saveChannelMeta,
} from "../src/gateway/session-store";
import { loadCase, newCase, saveCase } from "../src/case";
import {
  loadGatewayConfig,
  saveGatewayConfig,
} from "../src/gateway/config";
import { readAdminLog } from "../src/gateway/admin-log";
import {
  findAtomByApprovalMessage,
  loadAtoms,
  saveAtom,
  type KnowledgeAtom,
} from "../src/gateway/knowledge";
import { readGatewayEvents, appendGatewayEvent } from "../src/gateway/events";
import { loadTelemetry } from "../src/gateway/atom-telemetry";
import { saveUserSession } from "../src/gateway/session-store";
import { loadChannelTurns } from "../src/gateway/channel-log";
import { PmkContextTooLongError } from "../src/llm/claude-agent";

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
    await h.flush();

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

  it("threaded DM reply continues the SAME session as the top-level message (no thread-split)", async () => {
    // The bot threads its replies, so a user naturally replies inside the
    // bot's thread. Turn 1 is top-level (thread_ts undefined); turn 2 is a
    // reply in the thread the bot's turn-1 answer anchored (thread_ts = T1).
    // Both must resolve to ONE session, or the bot forgets turn 1.
    h.llm.script(
      "Noted — your project is codenamed Zaphod.",
      "Your project is codenamed Zaphod.",
    );
    await h.adapter.start();

    const T1 = "1700000200.000001";
    await h.socket.emit(
      "message",
      dmMessagePayload({
        user: "U-USER",
        channel: "D-USER-DM",
        text: "Remember: my project is codenamed Zaphod.",
        ts: T1,
      }),
    );
    await h.flush();

    await h.socket.emit(
      "message",
      dmMessagePayload({
        user: "U-USER",
        channel: "D-USER-DM",
        text: "What is my project codenamed?",
        ts: "1700000300.000002",
        thread_ts: T1, // reply inside the bot's turn-1 thread
      }),
    );
    await h.flush();

    assert.equal(h.llm.calls.length, 2, "both turns reach the LLM");
    const secondCallText = h.llm.calls[1].messages
      .map((m) => m.content)
      .join("\n");
    assert.match(
      secondCallText,
      /Zaphod/,
      "turn 2 must carry turn 1's history — a top-level msg and its threaded reply share one session",
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
    await h.flush();

    assert.equal(h.llm.calls.length, 0, "channel-scope message must skip LLM");
    assert.equal(h.web.updated.length, 0, "no update should fire");
  });

  it("attachment context reaches the LLM call and persists across the thread", async () => {
    const att = {
      summary: "_read: spec.md_",
      messages: [{ role: "user" as const, content: "[參考文件…] ZAPHOD_SPEC" }],
      entries: [{ fileId: "F1", name: "spec.md", mimetype: "text/markdown", text: "ZAPHOD_SPEC", at: 1 }],
    };
    h.cleanup();
    h = buildHarness({ attachmentIngest: async () => att });
    h.llm.script("Got the spec.", "Still got it.");
    await h.adapter.start();

    const T1 = "1700000800.000001";
    await h.socket.emit("message", dmMessagePayload({
      user: "U-USER", channel: "D-USER-DM", text: "read this", ts: T1, files: [{ id: "F1" }],
    }));
    await h.flush();
    const call1 = h.llm.calls[0].messages.map((m) => m.content).join("\n");
    assert.match(call1, /ZAPHOD_SPEC/, "attachment context present in the turn's LLM call");

    await h.socket.emit("message", dmMessagePayload({
      user: "U-USER", channel: "D-USER-DM", text: "what was the codename?", ts: "1700000800.000002", thread_ts: T1,
    }));
    await h.flush();
    const call2 = h.llm.calls[1].messages.map((m) => m.content).join("\n");
    assert.match(call2, /ZAPHOD_SPEC/, "attachment context persists across the thread");
  });

  it("file-only DM (no caption) is NOT dropped — ingests and runs a synthetic-prompt turn", async () => {
    let ingestedFiles: any[] = [];
    h.cleanup();
    h = buildHarness({
      attachmentIngest: async (files) => {
        ingestedFiles = files;
        return { summary: "_read: a.md_", messages: [{ role: "user" as const, content: "ATT_BODY" }], entries: [{ fileId: "F1", name: "a.md", mimetype: "text/markdown", text: "ATT_BODY", at: 1 }] };
      },
    });
    h.llm.script("I read your file.");
    await h.adapter.start();
    await h.socket.emit("message", dmMessagePayload({ user: "U-USER", channel: "D-USER-DM", text: "", files: [{ id: "F1" }] }));
    await h.flush();
    assert.equal(h.llm.calls.length, 1, "file-only DM must reach the LLM, not be dropped");
    assert.equal(ingestedFiles.length, 1);
  });

  it("blocklisted user gets the rejection notice and no LLM call", async () => {
    // Drop the beforeEach default before re-creating with a different
    // config — otherwise the old tmp HOME leaks (its cleanup never
    // runs and the next `buildHarness` snapshots HOME after our swap).
    h.cleanup();
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
    await h.flush();

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
    await h.flush();

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
    await h.flush();

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
    await h.flush();

    assert.equal(h.mra.askCalls.length, 1);
    assert.equal(h.llm.calls.length, 2, "synthesise still runs after mra failure");
    const finalText = h.web.updated[h.web.updated.length - 1].text ?? "";
    assert.match(finalText, /PKB summary/);
  });

  it("synthesise round context-too-long (both attempts) → friendly new-thread guidance, no crash", async () => {
    // First call delegates to mra; the synthesise round then blows the
    // context window on BOTH the initial attempt and the post-force-prune
    // retry, so synthesiseAfterMra re-throws PmkContextTooLongError and
    // run() must surface the friendly notice instead of crashing.
    const ctxErr = () => {
      throw new PmkContextTooLongError(new Error("msg_too_long"));
    };
    h.llm.script(
      "preamble.\n```mra-ask\nrepo: erp\nquestion: where is X?\n```",
      ctxErr,
      ctxErr,
    );
    h.mra.scriptAsk({
      ok: true,
      stdout: "scope :foo defined in models/x.rb:1",
      stderr: "",
      attempts: 1,
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
    await h.flush();

    assert.equal(
      h.llm.calls.length,
      3,
      "first-call + synthesise attempt + post-prune retry = 3 LLM calls",
    );
    const finalText = h.web.updated[h.web.updated.length - 1].text ?? "";
    assert.match(
      finalText,
      /對話太長.*重新提問/,
      "post-mra synthesise blow-up surfaces new-thread guidance, not a crash",
    );
  });

  it("synthesise retry re-evaluates ephemeralPrefix closure → attachment context shrinks on retry", async () => {
    // This test verifies Fix 1: the synthesise `buildMessages` closure calls
    // `buildEphemeralPrefix()` per-attempt so `onBeforeRetry`'s budget halving
    // actually shrinks the attachment portion sent to the LLM on retry.
    //
    // We use TWO entries whose combined text exceeds the halved budget (15 000)
    // but each individual entry is under it.  assembleFromEntries drops the
    // OLDEST entry when the full body exceeds the budget, so on retry the
    // rendered attachment block is shorter.
    //
    // Setup: TWO entries, each ~10 000 chars (combined ~20 000, above
    // MAX/2 = 15 000).  The first-call succeeds (mra-ask directive).
    // First synthesise attempt throws PmkContextTooLongError; budget halves
    // from 30 000 → 15 000; retry succeeds.
    //
    // Assertions:
    //   (a) message.capped {kind:"attachment"} event was emitted
    //   (b) the attachment user-message in synthesise call[2] is strictly
    //       shorter than in synthesise call[1]
    const TEXT_A = "A".repeat(10_000);
    const TEXT_B = "B".repeat(10_000);
    const entries = [
      { fileId: "F-OLD", name: "old.txt", mimetype: "text/plain", text: TEXT_A, at: 1 },
      { fileId: "F-NEW", name: "new.txt", mimetype: "text/plain", text: TEXT_B, at: 2 },
    ];
    const att = {
      summary: "_read: old.txt, new.txt_",
      messages: [{ role: "user" as const, content: "[參考文件] " + TEXT_A + TEXT_B }],
      entries,
    };
    h.cleanup();
    h = buildHarness({ attachmentIngest: async () => att });

    let synthesiseCallCount = 0;
    h.llm.script(
      // First-call: emit mra-ask directive
      "Consulting the repo.\n```mra-ask\nrepo: erp\nquestion: where is X?\n```",
      // First synthesise attempt: throws context-too-long
      () => { synthesiseCallCount++; throw new PmkContextTooLongError(new Error("msg_too_long")); },
      // Second synthesise attempt (after budget halve): succeeds
      () => { synthesiseCallCount++; return "Here is the synthesised answer."; },
    );
    h.mra.scriptAsk({
      ok: true,
      stdout: "scope :foo defined in models/x.rb:1",
      stderr: "",
      attempts: 1,
    });

    await h.adapter.start();
    await h.socket.emit(
      "message",
      dmMessagePayload({
        user: "U-PM",
        channel: "D-PM-DM",
        text: "where is X?",
        files: [{ id: "F-OLD" }, { id: "F-NEW" }],
      }),
    );
    await h.flush();

    // Should be: first-call (1) + first synthesise (2) + retry synthesise (3)
    assert.equal(h.llm.calls.length, 3, "first-call + 2 synthesise attempts = 3 LLM calls");
    assert.equal(synthesiseCallCount, 2, "synthesise was attempted twice");

    // (a) A message.capped {kind:"attachment"} event was emitted
    const cappedEvents = readGatewayEvents().filter(
      (e) => (e as { type: string; kind?: string }).type === "message.capped" &&
              (e as { type: string; kind?: string }).kind === "attachment",
    );
    assert.ok(cappedEvents.length >= 1, "message.capped {kind:attachment} event must be emitted");

    // (b) The attachment user-message (the ephemeral prefix user turn carrying
    // the [參考文件] block) in the synthesise retry must be strictly shorter
    // than in the first synthesise attempt, because assembleFromEntries dropped
    // the older entry when the budget was halved.
    const FRAME = "[參考文件";
    const attachLen = (callIdx: number): number =>
      h.llm.calls[callIdx].messages
        .filter((m) => m.role === "user" && m.content.startsWith(FRAME))
        .reduce((acc, m) => acc + m.content.length, 0);

    const synth1Len = attachLen(1);
    const synth2Len = attachLen(2);

    assert.ok(synth1Len > 0, "first synthesise call must include an attachment user-message");
    assert.ok(
      synth2Len < synth1Len,
      `synthesise retry attachment content (${synth2Len}) must be shorter than first attempt (${synth1Len})`,
    );
  });
});

describe("SlackAdapter integration: channel @-mention", () => {
  let h: Harness;

  beforeEach(() => {
    h = buildHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("channel mention without active case → free chat", async () => {
    h.llm.script("Channel free-chat answer about the codebase.");
    await h.adapter.start();

    await h.socket.emit(
      "app_mention",
      appMentionPayload({
        user: "U-PM",
        channel: "C-DESIGN",
        text: "<@UBOTID> what does this module do?",
      }),
    );
    await h.flush();

    assert.equal(h.llm.calls.length, 1);
    // Bot-mention prefix is stripped before reaching the LLM.
    const userTurn = h.llm.calls[0].messages.find((m) => m.role === "user");
    assert.ok(userTurn, "user turn should be present");
    assert.doesNotMatch(
      userTurn!.content,
      /<@UBOTID>/,
      "leading bot mention must be stripped",
    );

    assert.ok(h.web.updated.length >= 1);
    assert.match(
      h.web.updated[h.web.updated.length - 1].text ?? "",
      /Channel free-chat/,
    );
  });

  it("threaded channel mention continues the SAME session as the top-level mention (no thread-split)", async () => {
    // Same split as the DM path: a top-level mention's reply is threaded,
    // the user replies in that thread, and turn 2 must still see turn 1.
    h.llm.script(
      "Noted — the channel codename is Vogon.",
      "The channel codename is Vogon.",
    );
    await h.adapter.start();

    const T1 = "1700000500.000001";
    await h.socket.emit(
      "app_mention",
      appMentionPayload({
        user: "U-PM",
        channel: "C-CONT",
        text: "<@UBOTID> remember: the channel codename is Vogon",
        ts: T1,
      }),
    );
    await h.flush();

    await h.socket.emit(
      "app_mention",
      appMentionPayload({
        user: "U-PM",
        channel: "C-CONT",
        text: "<@UBOTID> what is the channel codename?",
        ts: "1700000600.000002",
        thread_ts: T1, // reply inside the bot's turn-1 thread
      }),
    );
    await h.flush();

    assert.equal(h.llm.calls.length, 2, "both turns reach the LLM");
    const secondCallText = h.llm.calls[1].messages
      .map((m) => m.content)
      .join("\n");
    assert.match(
      secondCallText,
      /Vogon/,
      "turn 2 must carry turn 1 — a top-level mention and its threaded reply share one channel session",
    );
  });

  it("channel mention with active case → routes to case path, appends turns", async () => {
    const channelId = "C-INCIDENT";
    const caseName = "2026-05-19-payments-outage";

    // Bootstrap an open case + active channel meta directly via the
    // session-store + case modules — same surface `/pmk open` uses,
    // but cheaper than scripting an extra slash-command first.
    const dir = channelCasesDir(channelId);
    const seed = newCase({
      name: caseName,
      title: "Payments service returning 500",
      symptom: "5xx spike at 14:02 UTC; rate ~12% of requests",
    });
    saveCase(seed, dir);
    saveChannelMeta({
      channelId,
      activeCase: caseName,
      lastActiveAt: Date.now(),
    });

    h.llm.script(
      "Looking at the symptoms, the most likely culprit is the new retry queue.\n" +
        "```case-update\n" +
        "hypothesis: retry queue backpressure under load\n" +
        "next-question: when did the retry queue ship?\n" +
        "```",
    );

    await h.adapter.start();

    await h.socket.emit(
      "app_mention",
      appMentionPayload({
        user: "U-OPS",
        channel: channelId,
        text: "<@UBOTID> any theories on root cause?",
      }),
    );
    await h.flush();

    assert.equal(h.llm.calls.length, 1, "case path uses one LLM call");

    const after = loadCase(caseName, dir);
    // user turn + assistant turn appended after the bootstrap (which
    // started with an empty messages array).
    assert.equal(after.messages.length, 2);
    assert.equal(after.messages[0].role, "user");
    assert.match(after.messages[0].content, /root cause/);
    assert.equal(after.messages[1].role, "assistant");
    // The persisted assistant text has the case-update block stripped.
    assert.doesNotMatch(after.messages[1].content, /```case-update/);
    // The directive's actions landed on the case state.
    assert.equal(after.hypotheses.length, 1);
    assert.match(after.hypotheses[0].text, /retry queue backpressure/);
    assert.equal(after.openQuestions.length, 1);

    // Slack-side surface: placeholder + final update; tracking summary
    // (counts of added hypotheses / questions) posted as a follow-up
    // message in the same thread.
    assert.ok(h.web.updated.length >= 1, "final update should fire");
    const summaryPosts = h.web
      .postsTo(channelId)
      .filter((p) => p.text && !p.text.includes("thinking"));
    assert.ok(summaryPosts.length >= 1, "tracking summary should be posted");
  });

  it("case path: PmkContextTooLong → force-prune → retry success → :scissors: prefix", async () => {
    const channelId = "C-LONGCASE";
    const caseName = "2026-06-05-bloated-case";
    const dir = channelCasesDir(channelId);
    const seed = newCase({
      name: caseName,
      title: "Long-running incident",
      symptom: "lots of back-and-forth",
    });
    // Paired history so forcePruneToMinimum has turns to drop.
    seed.messages = [
      { role: "user", content: "Q1 ..." },
      { role: "assistant", content: "A1 ..." },
      { role: "user", content: "Q2 ..." },
      { role: "assistant", content: "A2 ..." },
      { role: "user", content: "Q3 ..." },
      { role: "assistant", content: "A3 ..." },
    ];
    saveCase(seed, dir);
    saveChannelMeta({ channelId, activeCase: caseName, lastActiveAt: Date.now() });

    h.llm.script(
      () => {
        throw new PmkContextTooLongError(new Error("msg_too_long"));
      },
      "After pruning, the cleaner case analysis.",
    );

    await h.adapter.start();
    await h.socket.emit(
      "app_mention",
      appMentionPayload({
        user: "U-OPS",
        channel: channelId,
        text: "<@UBOTID> another long follow-up",
      }),
    );
    await h.flush();

    assert.equal(
      h.llm.calls.length,
      2,
      "case path retries after force-prune (parity with free-chat)",
    );
    const finalText = h.web.updated[h.web.updated.length - 1].text ?? "";
    assert.match(
      finalText,
      /^:scissors: 對話過長，已自動裁掉 \d+ 輪舊訊息/,
      "case reply gets the same scissors trim notice as free-chat",
    );
    assert.match(finalText, /cleaner case analysis/);
    const eventTypes = readGatewayEvents().map(
      (e) => (e as { type: string }).type,
    );
    assert.ok(eventTypes.includes("context.force-pruned"));
  });

  it("case path: both attempts PmkContextTooLong → friendly new-thread guidance", async () => {
    const channelId = "C-DEADCASE";
    const caseName = "2026-06-05-unrecoverable";
    const dir = channelCasesDir(channelId);
    const seed = newCase({
      name: caseName,
      title: "Unrecoverable",
      symptom: "huge",
    });
    seed.messages = [
      { role: "user", content: "Q1 ..." },
      { role: "assistant", content: "A1 ..." },
      { role: "user", content: "Q2 ..." },
      { role: "assistant", content: "A2 ..." },
    ];
    saveCase(seed, dir);
    saveChannelMeta({ channelId, activeCase: caseName, lastActiveAt: Date.now() });

    const ctxErr = () => {
      throw new PmkContextTooLongError(new Error("msg_too_long"));
    };
    h.llm.script(ctxErr, ctxErr);

    await h.adapter.start();
    await h.socket.emit(
      "app_mention",
      appMentionPayload({
        user: "U-OPS",
        channel: channelId,
        text: "<@UBOTID> still huge",
      }),
    );
    await h.flush();

    const finalText = h.web.updated[h.web.updated.length - 1].text ?? "";
    assert.match(
      finalText,
      /對話太長.*重新提問/,
      "case hard-fail surfaces new-thread guidance, not a generic error",
    );
  });

  it("mention-only channel upload (no caption) is NOT dropped", async () => {
    h.cleanup();
    h = buildHarness({ attachmentIngest: async () => ({ summary: "_read: a.md_", messages: [{ role: "user" as const, content: "ATT" }], entries: [{ fileId: "F1", name: "a.md", mimetype: "text/markdown", text: "ATT", at: 1 }] }) });
    h.llm.script("read it");
    await h.adapter.start();
    await h.socket.emit("app_mention", appMentionPayload({ user: "U-PM", channel: "C-AT", text: "<@UBOTID>", files: [{ id: "F1" }] }));
    await h.flush();
    assert.equal(h.llm.calls.length, 1, "mention-only file upload must reach the LLM");
  });

  it("active-case channel upload does NOT ingest attachments", async () => {
    let ingestCalled = false;
    h.cleanup();
    h = buildHarness({ attachmentIngest: async () => { ingestCalled = true; return { summary: "", messages: [], entries: [] }; } });
    h.llm.script("case reply");
    await h.adapter.start();
    // Set up an active case in C-CASE — same setup as the "channel mention with active case" test.
    const channelId = "C-CASE";
    const caseName = "2026-06-09-active-case";
    const dir = channelCasesDir(channelId);
    const seed = newCase({
      name: caseName,
      title: "Active case",
      symptom: "test",
    });
    saveCase(seed, dir);
    saveChannelMeta({
      channelId,
      activeCase: caseName,
      lastActiveAt: Date.now(),
    });
    await h.socket.emit("app_mention", appMentionPayload({ user: "U-PM", channel: "C-CASE", text: "<@UBOTID> note this", files: [{ id: "F1" }] }));
    await h.flush();
    assert.equal(ingestCalled, false, "case mode must not ingest attachments");
  });
});

describe("SlackAdapter integration: /pmk admin slash command", () => {
  let h: Harness;

  beforeEach(() => {
    h = buildHarness({ config: { admins: ["U-HOST"] } });
    // handleAdminSlash → adminAudience → loadGatewayConfig reads from
    // disk, so the in-memory config the harness built needs to be
    // committed to the tmp HOME before any admin command can succeed.
    saveGatewayConfig({
      version: 1,
      admins: ["U-HOST"],
      blocklist: [],
      audience: { default: "tech", users: {}, channels: {} },
      escalation: { default: [], repos: {} },
      slack: {
        appToken: "xapp-test",
        botToken: "xoxb-test",
        botUserId: "UBOTID",
        workspaceName: "test-workspace",
      },
    });
  });

  afterEach(() => {
    h.cleanup();
  });

  it("admin sets audience override → config mutates, admin.log appends, success replied", async () => {
    await h.adapter.start();

    await h.socket.emit(
      "slash_commands",
      slashCommandPayload({
        user_id: "U-HOST",
        channel_id: "D-HOST-DM",
        text: "admin audience set <@UOTHER> exec",
      }),
    );
    await h.flush();

    // Config now persists the per-user override.
    const after = loadGatewayConfig();
    assert.equal(after.audience.users["UOTHER"], "exec");

    // admin.log captured the mutation.
    const log = readAdminLog();
    assert.equal(log.length, 1);
    assert.equal(log[0].actor, "U-HOST");
    assert.equal(log[0].origin, "slack");
    assert.equal(log[0].action, "audience.set");
    assert.equal(log[0].ok, true);
    assert.match(log[0].args ?? "", /UOTHER exec/);

    // Reply posted to the DM channel.
    const posts = h.web.postsTo("D-HOST-DM");
    assert.equal(posts.length, 1);
    assert.match(posts[0].text ?? "", /audience set to/);
  });

  it("non-admin user → blocked, no admin.log entry, no config mutation", async () => {
    await h.adapter.start();

    await h.socket.emit(
      "slash_commands",
      slashCommandPayload({
        user_id: "U-RANDOM",
        channel_id: "D-RANDOM-DM",
        text: "admin audience set <@UVICTIM> biz",
      }),
    );
    await h.flush();

    const after = loadGatewayConfig();
    assert.equal(
      after.audience.users["UVICTIM"],
      undefined,
      "non-admin must not be able to mutate config",
    );

    // No admin-action entry; the gate fires upstream of handleAdminSlash.
    const log = readAdminLog();
    assert.equal(log.length, 0, "permission deny is not logged in admin.log");

    const posts = h.web.postsTo("D-RANDOM-DM");
    assert.equal(posts.length, 1);
    assert.match(posts[0].text ?? "", /限管理員/);
  });

  it("/pmk admin invoked outside DM scope → rejected with DM-only notice", async () => {
    await h.adapter.start();

    await h.socket.emit(
      "slash_commands",
      slashCommandPayload({
        user_id: "U-HOST",
        channel_id: "C-PUBLIC",
        text: "admin audience set <@UOTHER> biz",
      }),
    );
    await h.flush();

    const after = loadGatewayConfig();
    assert.equal(after.audience.users["UOTHER"], undefined);

    const log = readAdminLog();
    assert.equal(log.length, 0);

    const posts = h.web.postsTo("C-PUBLIC");
    assert.equal(posts.length, 1);
    assert.match(posts[0].text ?? "", /只能在 DM/);
  });
});

describe("SlackAdapter integration: reaction-based atom approval", () => {
  let h: Harness;

  function seedPendingAtom(args: {
    channelId: string;
    messageTs: string;
    contributorUserId: string;
  }): KnowledgeAtom {
    const atom: KnowledgeAtom = {
      id: "atom-test-12345",
      createdAt: Date.now(),
      scope: "general",
      question: "where is sales_performances defined?",
      answer: "models/order.rb:42",
      summary: "sales_performances scope lives in the Order model.",
      tags: ["erp", "scope"],
      source: {
        threadKey: `${args.channelId}:${args.messageTs}`,
        contributorUserId: args.contributorUserId,
      },
      status: "pending",
      expiresAt: Date.now() + 24 * 3600 * 1000,
      approval: { channelId: args.channelId, messageTs: args.messageTs },
    };
    saveAtom(atom);
    return atom;
  }

  beforeEach(() => {
    h = buildHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it(":white_check_mark: from the contributor promotes pending atom to approved", async () => {
    const channelId = "C-OPS";
    const messageTs = "1700000300.000300";
    const contributor = "U-IT";

    seedPendingAtom({ channelId, messageTs, contributorUserId: contributor });

    await h.adapter.start();
    await h.socket.emit(
      "reaction_added",
      reactionAddedPayload({
        user: contributor,
        reaction: "white_check_mark",
        itemChannel: channelId,
        itemTs: messageTs,
      }),
    );
    await h.flush();

    // Atom flipped to approved on disk.
    const after = loadAtoms({ promote: false });
    assert.equal(after.length, 1);
    assert.equal(after[0].status, "approved");
    assert.equal(after[0].expiresAt, undefined);

    // Confirmation reply posted in the thread.
    const replies = h.web
      .postsTo(channelId)
      .filter((p) => p.thread_ts === messageTs);
    assert.equal(replies.length, 1);
    assert.match(replies[0].text ?? "", /生效/);
  });

  it(":x: from the contributor deletes the pending atom", async () => {
    const channelId = "C-OPS";
    const messageTs = "1700000400.000400";
    const contributor = "U-IT";

    seedPendingAtom({ channelId, messageTs, contributorUserId: contributor });

    await h.adapter.start();
    await h.socket.emit(
      "reaction_added",
      reactionAddedPayload({
        user: contributor,
        reaction: "x",
        itemChannel: channelId,
        itemTs: messageTs,
      }),
    );
    await h.flush();

    // Atom file removed from disk.
    const after = loadAtoms({ promote: false });
    assert.equal(after.length, 0);

    const replies = h.web
      .postsTo(channelId)
      .filter((p) => p.thread_ts === messageTs);
    assert.equal(replies.length, 1);
    assert.match(replies[0].text ?? "", /捨棄/);
  });

  it("thumbsdown on a pending-atom approval anchor must NOT reject the atom (regression)", async () => {
    const channelId = "C-OPS";
    const messageTs = "1700000450.000450";
    const contributor = "U-IT";

    seedPendingAtom({ channelId, messageTs, contributorUserId: contributor });

    await h.adapter.start();
    await h.socket.emit(
      "reaction_added",
      reactionAddedPayload({
        user: contributor,
        reaction: "thumbsdown",
        itemChannel: channelId,
        itemTs: messageTs,
        // item_user is the bot — makes the anchor lookup fire.
        itemUser: "UBOTID",
      }),
    );
    await h.flush();

    // Atom must still exist and stay pending — thumbsdown is not a
    // reject signal on an approval anchor.
    const after = loadAtoms({ promote: false });
    assert.equal(after.length, 1, "atom must not be deleted by thumbsdown");
    assert.equal(
      after[0].status,
      "pending",
      "atom status must stay pending — thumbsdown must not act as a reject",
    );

    // No rejection confirmation posted.
    const replies = h.web
      .postsTo(channelId)
      .filter((p) => p.thread_ts === messageTs);
    assert.equal(
      replies.length,
      0,
      "no reply should be posted for a thumbsdown on an approval anchor",
    );
  });

  it("non-contributor reaction is ignored — atom stays pending", async () => {
    const channelId = "C-OPS";
    const messageTs = "1700000500.000500";
    const contributor = "U-IT";
    const stranger = "U-RANDOM";

    seedPendingAtom({ channelId, messageTs, contributorUserId: contributor });

    await h.adapter.start();
    await h.socket.emit(
      "reaction_added",
      reactionAddedPayload({
        user: stranger,
        reaction: "white_check_mark",
        itemChannel: channelId,
        itemTs: messageTs,
      }),
    );
    await h.flush();

    const after = loadAtoms({ promote: false });
    assert.equal(after.length, 1);
    assert.equal(
      after[0].status,
      "pending",
      "atom must stay pending when a non-contributor reacts",
    );

    assert.equal(
      h.web.postsTo(channelId).length,
      0,
      "no confirmation post for an ignored reaction",
    );
  });

  it("reaction on a non-atom message is a no-op (other reactions still flow elsewhere)", async () => {
    await h.adapter.start();
    await h.socket.emit(
      "reaction_added",
      reactionAddedPayload({
        user: "U-ANY",
        reaction: "white_check_mark",
        itemChannel: "C-ANYWHERE",
        itemTs: "1700000999.999999",
      }),
    );
    await h.flush();

    // No findAtomByApprovalMessage match → return early; no posts, no
    // atom mutation.
    assert.equal(h.web.posted.length, 0);
    assert.equal(loadAtoms({ promote: false }).length, 0);
    // Sanity: lookup function agrees the message is not anchored.
    assert.equal(
      findAtomByApprovalMessage("C-ANYWHERE", "1700000999.999999"),
      undefined,
    );
  });
});

describe("SlackAdapter integration: :cr: reaction routes to ReviewCoordinator", () => {
  let h: Harness;

  afterEach(() => {
    h.cleanup();
  });

  it("cr reaction on a user message routes to ReviewCoordinator (skip note posted for empty workspace)", async () => {
    // Arrange: enable review in config; mraWorkspace points at a tmp dir with no
    // .collab/repos.json so resolveProjectByRemote returns undefined → ReviewCoordinator
    // posts the "不在 mra workspace，略過" skip note. This proves the gate let :cr:
    // through without requiring a real mra binary or GitHub token.
    const mraWorkspace = h?.home ?? "/tmp"; // will be set below
    h = buildHarness({
      config: {
        review: { enabled: true },
        mraWorkspace: "/tmp/no-such-workspace-cr-test",
      },
    });

    // conversations.history should return a message containing a GitHub PR link
    // so parsePrRefs finds at least one ref and the coordinator proceeds past
    // the "no refs" early return.
    h.web.conversationsHistoryResponse = {
      ok: true,
      messages: [{ text: ":cr: https://github.com/onead/OnePixel/pull/12" }],
    };

    await h.adapter.start();

    await h.socket.emit(
      "reaction_added",
      reactionAddedPayload({
        user: "U-DEV",
        reaction: "cr",
        itemChannel: "C-CH",
        itemTs: "1700000200.000200",
        // itemUser is a human (NOT the bot) — the gate must NOT block this
        itemUser: "U-HUMAN-POSTER",
      }),
    );
    await h.flush();

    // The coordinator acks immediately, then reaches resolveProjectByRemote →
    // not found → posts a skip note. Both prove the gate routed :cr: through.
    const posts = h.web.postsTo("C-CH");
    assert.ok(
      posts.length > 0,
      "ReviewCoordinator should post (ack + skip note) when routed",
    );
    assert.ok(
      posts.some((p) => /收到.*背景 review/.test(p.text ?? "")),
      "an immediate ack should be posted",
    );
    assert.ok(
      posts.some((p) => /略過/.test(p.text ?? "")),
      "a skip note ('略過') should be posted when project is not in workspace",
    );
  });

  it("a blocklisted user's :cr: reaction is ignored (parity with the message/mention paths)", async () => {
    h = buildHarness({
      config: {
        blocklist: ["U-BAD"],
        review: { enabled: true },
        mraWorkspace: "/tmp/no-such-workspace-cr-block",
      },
    });
    h.web.conversationsHistoryResponse = {
      ok: true,
      messages: [{ text: ":cr: https://github.com/onead/OnePixel/pull/12" }],
    };
    await h.adapter.start();
    await h.socket.emit(
      "reaction_added",
      reactionAddedPayload({
        user: "U-BAD",
        reaction: "cr",
        itemChannel: "C-CH",
        itemTs: "1700000201.000201",
        itemUser: "U-HUMAN-POSTER",
      }),
    );
    await h.flush();
    assert.equal(
      h.web.postsTo("C-CH").length,
      0,
      "a blocklisted user must not drive any :cr: review side-effect",
    );
  });

  it("a blocklisted user's :a: approve reaction is ignored (no GitHub approve side-effect)", async () => {
    h = buildHarness({
      config: {
        blocklist: ["U-BAD"],
        review: { enabled: true },
        mraWorkspace: "/tmp/no-such-workspace-a-block",
      },
    });
    h.web.conversationsHistoryResponse = {
      ok: true,
      messages: [{ text: ":a: https://github.com/onead/OnePixel/pull/12" }],
    };
    await h.adapter.start();
    await h.socket.emit(
      "reaction_added",
      reactionAddedPayload({
        user: "U-BAD",
        reaction: "a",
        itemChannel: "C-CH",
        itemTs: "1700000202.000202",
        itemUser: "U-HUMAN-POSTER",
      }),
    );
    await h.flush();
    assert.equal(
      h.web.postsTo("C-CH").length,
      0,
      "a blocklisted user must not drive any :a: approve side-effect",
    );
  });
});

describe("SlackAdapter integration: 👎 on cited reply marks atoms questioned", () => {
  let h: Harness;

  beforeEach(() => {
    h = buildHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("thumbsdown on a cited bot reply bumps questionedCount and dedupes", async () => {
    const channelId = "D1";
    const replyTs = "999.1";
    const atomId = "a1";

    // Seed a turn.processed event that links this reply to an atom.
    appendGatewayEvent({
      type: "turn.processed",
      actor: "U-ANY",
      audience: "biz",
      hadMraAsk: false,
      atomsInjected: 1,
      atomIds: [atomId],
      channelId,
      replyTs,
    });

    await h.adapter.start();

    const payload = reactionAddedPayload({
      user: "U-any",
      reaction: "-1",
      itemChannel: channelId,
      itemTs: replyTs,
      // item_user must be the bot so the handler doesn't early-return
      itemUser: "UBOTID",
    });

    // First reaction: bumps questionedCount to 1.
    await h.socket.emit("reaction_added", payload);
    await h.flush();

    assert.equal(
      loadTelemetry().atoms[atomId]?.questionedCount,
      1,
      "first 👎 should increment questionedCount to 1",
    );

    // Same payload again: dedupe key prevents double-counting.
    await h.socket.emit("reaction_added", payload);
    await h.flush();

    assert.equal(
      loadTelemetry().atoms[atomId]?.questionedCount,
      1,
      "duplicate reaction must be deduped; questionedCount stays 1",
    );
  });

  it(":x: on the same cited reply does NOT trigger citation-questioned", async () => {
    const channelId = "D1";
    const replyTs = "999.2";
    const atomId = "a2";

    appendGatewayEvent({
      type: "turn.processed",
      actor: "U-ANY",
      audience: "biz",
      hadMraAsk: false,
      atomsInjected: 1,
      atomIds: [atomId],
      channelId,
      replyTs,
    });

    await h.adapter.start();

    await h.socket.emit(
      "reaction_added",
      reactionAddedPayload({
        user: "U-any",
        reaction: "x",
        itemChannel: channelId,
        itemTs: replyTs,
        itemUser: "UBOTID",
      }),
    );
    await h.flush();

    const entry = loadTelemetry().atoms[atomId];
    assert.equal(
      entry?.questionedCount ?? 0,
      0,
      ":x: must not trigger citation-questioned (it is reserved for approval-reject)",
    );
  });
});

describe("SlackAdapter integration: presence broadcast (#44)", () => {
  let h: Harness;

  afterEach(() => {
    h.cleanup();
  });

  /** Filter readGatewayEvents output to a single event type for cleaner asserts. */
  function eventsOfType(type: string): Array<Record<string, unknown>> {
    return readGatewayEvents().filter(
      (e) => (e as { type: string }).type === type,
    ) as unknown as Array<Record<string, unknown>>;
  }

  it("first-ever start (no offline duration) → broadcasts online with broadcast:true", async () => {
    h = buildHarness();
    await h.adapter.start();

    const online = eventsOfType("gateway.online");
    assert.equal(online.length, 1);
    assert.equal(online[0].broadcast, true);
    // No suppression reason — falls into the crash-recovery branch
    // because gracefulShutdown defaulted to false.
    assert.equal(online[0].reason, "crash-recovery");
  });

  it("fast graceful restart (offline < 5min, graceful=true) → suppress with broadcast:false", async () => {
    h = buildHarness({
      wasOffline: true,
      offlineDurationMs: 60_000, // 1 min, well under MIN_BROADCAST_GAP_MS=5min
      gracefulShutdown: true,
    });
    await h.adapter.start();

    const online = eventsOfType("gateway.online");
    assert.equal(online.length, 1);
    assert.equal(online[0].broadcast, false);
    assert.equal(online[0].reason, "graceful-fast-restart");
    assert.equal(online[0].offlineDurationMs, 60_000);
  });

  it("fast crash recovery (offline < 5min, gracefulShutdown=false) → suppress with reason fast-recovery", async () => {
    h = buildHarness({
      wasOffline: true,
      offlineDurationMs: 30_000,
      gracefulShutdown: false,
    });
    await h.adapter.start();

    const online = eventsOfType("gateway.online");
    assert.equal(online.length, 1);
    assert.equal(online[0].broadcast, false);
    assert.equal(online[0].reason, "fast-recovery");
  });

  it("long downtime (offline > 5min) → actually broadcasts to recently-active recipients", async () => {
    h = buildHarness({
      wasOffline: true,
      offlineDurationMs: 30 * 60_000, // 30 min, well past threshold
      gracefulShutdown: false,
    });
    // Seed one recently-active DM so listRecentUsers has a recipient.
    saveUserSession({
      userId: "U-RECENT",
      messages: [],
      lastActiveAt: Date.now(),
      approxTokens: 0,
      turns: 0,
    });

    await h.adapter.start();

    const online = eventsOfType("gateway.online");
    assert.equal(online.length, 1);
    assert.equal(online[0].broadcast, true);
    assert.equal(online[0].reason, "crash-recovery");

    // Fan-out attempted an actual DM post for the recent user (via
    // dmSafe → conversations.open then chat.postMessage). In the harness
    // the fake `conversations.history` and `users.info` defaults are
    // benign, so chat.postMessage should have been called at least once
    // with a back-online notice.
    assert.ok(
      h.web.posted.length >= 1,
      "broadcast should reach at least the seeded recent user",
    );
    assert.match(
      h.web.posted[0].text ?? "",
      /上線|back|online/i,
      "broadcast text should mention coming back online",
    );
  });

  it("stop() emits gateway.offline as an audit-only event (no user '暫離' fan-out)", async () => {
    h = buildHarness();
    // Seed a recently-active DM so a fan-out WOULD have a recipient.
    saveUserSession({
      userId: "U-RECENT",
      messages: [{ role: "user", content: "hi" }],
      lastActiveAt: Date.now(),
      approxTokens: 1,
      turns: 0,
    });
    await h.adapter.start();
    const postsBefore = h.web.posted.length;
    await h.adapter.stop();

    // Graceful shutdown records the audit event but does NOT spam users:
    // a graceful stop is ~always a fast restart, and a real crash can't
    // run this path at all. So broadcast:false and no offline-notice post.
    const offline = eventsOfType("gateway.offline");
    assert.equal(offline.length, 1);
    assert.equal(offline[0].broadcast, false);
    assert.equal(offline[0].reason, "shutdown");
    const offlinePosts = h.web.posted
      .slice(postsBefore)
      .filter((p) => (p.text ?? "").includes("暫離"));
    assert.equal(offlinePosts.length, 0, "no '暫離' notice should be posted on a graceful stop");
  });
});

describe("SlackAdapter integration: msg_too_long hardening (v0.11.1)", () => {
  let h: Harness;

  /** Seed a paired DM history so `forcePruneToMinimum` has turns to drop. */
  // A top-level DM now keys its session by the opening message's ts (the
  // bot threads its reply there), so seed under the dmMessagePayload default
  // ts rather than "main" — otherwise the handler loads an empty session.
  const DM_DEFAULT_TS = "1700000100.000100";
  function seedPairedHistory(userId: string) {
    saveUserSession(
      {
        userId,
        messages: [
          { role: "user", content: "Q1: walk me through the order schema" },
          { role: "assistant", content: "A1: orders has columns a, b, c…" },
          { role: "user", content: "Q2: and the payments table?" },
          { role: "assistant", content: "A2: payments has fields x, y, z…" },
          { role: "user", content: "Q3: any indexes I should know?" },
          { role: "assistant", content: "A3: idx_orders_status, idx_payments_id…" },
        ],
        lastActiveAt: Date.now(),
        approxTokens: 30_000,
        turns: 3,
      },
      DM_DEFAULT_TS,
    );
  }

  beforeEach(() => {
    h = buildHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("first call PmkContextTooLong → force-prune → retry success → :scissors: prefix + events", async () => {
    const userId = "U-CHATTY";
    seedPairedHistory(userId);

    h.llm.script(
      () => {
        throw new PmkContextTooLongError(new Error("msg_too_long"));
      },
      "After pruning, here is the cleaner answer.",
    );

    await h.adapter.start();
    await h.socket.emit(
      "message",
      dmMessagePayload({
        user: userId,
        channel: "D-CHATTY-DM",
        text: "and what about the reports table?",
      }),
    );
    await h.flush();

    assert.equal(
      h.llm.calls.length,
      2,
      "LLM called twice: original throws, retry succeeds",
    );

    const finalText = h.web.updated[h.web.updated.length - 1].text ?? "";
    assert.match(
      finalText,
      /^:scissors: 對話過長，已自動裁掉 \d+ 輪舊訊息/,
      "final reply prefixed with the scissors trim notice",
    );
    assert.match(finalText, /cleaner answer/);

    const eventTypes = readGatewayEvents().map(
      (e) => (e as { type: string }).type,
    );
    assert.ok(eventTypes.includes("context.exceeded"));
    assert.ok(eventTypes.includes("context.force-pruned"));
  });

  it("first call AND retry both PmkContextTooLong → hard-fail with :x: notice", async () => {
    const userId = "U-CHATTY2";
    seedPairedHistory(userId);

    const ctxErr = () => {
      throw new PmkContextTooLongError(new Error("msg_too_long"));
    };
    h.llm.script(ctxErr, ctxErr);

    await h.adapter.start();
    await h.socket.emit(
      "message",
      dmMessagePayload({
        user: userId,
        channel: "D-CHATTY2-DM",
        text: "another huge follow-up",
      }),
    );
    await h.flush();

    assert.equal(h.llm.calls.length, 2);
    const finalText = h.web.updated[h.web.updated.length - 1].text ?? "";
    assert.match(
      finalText,
      /對話太長.*重新提問/,
      "hard-fail surfaces the new-thread guidance, not the raw API error",
    );
  });

  it("non-context error surfaces as :warning: error message (no force-prune)", async () => {
    h.llm.script(() => {
      throw new Error("rate limit exceeded");
    });

    await h.adapter.start();
    await h.socket.emit(
      "message",
      dmMessagePayload({
        user: "U-PM",
        channel: "D-PM-DM",
        text: "hello",
      }),
    );
    await h.flush();

    assert.equal(
      h.llm.calls.length,
      1,
      "non-context errors must not trigger the retry path",
    );
    const finalText = h.web.updated[h.web.updated.length - 1].text ?? "";
    assert.match(finalText, /:warning:/);
    assert.match(finalText, /rate limit/);

    const eventTypes = readGatewayEvents().map(
      (e) => (e as { type: string }).type,
    );
    assert.equal(
      eventTypes.includes("context.exceeded"),
      false,
      "no context.exceeded for non-context errors",
    );
  });
});

describe("SlackAdapter integration: envelope dedup", () => {
  let h: Harness;

  beforeEach(() => {
    h = buildHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("same envelope_id delivered twice → handler runs once (DM path)", async () => {
    h.llm.script("first answer", "second answer");
    await h.adapter.start();

    const payload = dmMessagePayload({
      user: "U-PM",
      channel: "D-PM-DM",
      text: "first delivery",
      envelope_id: "env-dupe-12345",
    });
    await h.socket.emit("message", payload);
    await h.flush();
    await h.socket.emit("message", payload);
    await h.flush();

    assert.equal(
      h.llm.calls.length,
      1,
      "duplicate envelope_id must be deduped before reaching the LLM",
    );
    assert.equal(h.web.updated.length, 1, "only one final update fires");
  });

  it("retry_num > 0 is dropped (DM path)", async () => {
    h.llm.script("should not be called");
    await h.adapter.start();

    await h.socket.emit(
      "message",
      dmMessagePayload({
        user: "U-PM",
        channel: "D-PM-DM",
        text: "retried delivery",
        envelope_id: "env-retry-1",
        retry_num: 1,
      }),
    );
    await h.flush();

    assert.equal(h.llm.calls.length, 0, "retry_num>0 envelopes are dropped");
    assert.equal(h.web.posted.length, 0, "no placeholder, no anything");
  });

  it("same envelope_id delivered twice → handler runs once (app_mention path)", async () => {
    h.llm.script("first", "second");
    await h.adapter.start();

    const payload = appMentionPayload({
      user: "U-PM",
      channel: "C-DESIGN",
      text: "<@UBOTID> hello",
      envelope_id: "env-mention-dupe",
    });
    await h.socket.emit("app_mention", payload);
    await h.flush();
    await h.socket.emit("app_mention", payload);
    await h.flush();

    assert.equal(h.llm.calls.length, 1);
    assert.equal(h.web.updated.length, 1);
  });

  it("same envelope_id delivered twice → handler runs once (slash_commands path)", async () => {
    // Drop the beforeEach default before re-creating with admins set —
    // otherwise the old tmp HOME leaks (its cleanup never fires and
    // the next `buildHarness` snapshots HOME after our swap).
    h.cleanup();
    h = buildHarness({ config: { admins: ["U-HOST"] } });
    await h.adapter.start();

    const payload = slashCommandPayload({
      user_id: "U-HOST",
      channel_id: "D-HOST-DM",
      text: "admin status",
      envelope_id: "env-slash-dupe",
    });
    await h.socket.emit("slash_commands", payload);
    await h.flush();
    await h.socket.emit("slash_commands", payload);
    await h.flush();

    // The admin-log row is the cleanest "did the handler actually run"
    // signal — and there should be exactly one even after two deliveries.
    const log = readAdminLog();
    assert.equal(log.length, 1);
    assert.equal(log[0].action, "status");
  });
});

describe("SlackAdapter integration: inflight queue (v0.13)", () => {
  let h: Harness;

  beforeEach(() => {
    h = buildHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("different users in same channel run concurrently (per-user-per-channel key)", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    h.llm.script(
      async () => {
        await firstGate;
        return "answer for alice";
      },
      "answer for bob",
    );

    await h.adapter.start();

    // Both emits are fire-and-forget (handlers enqueue + return fast).
    void h.socket.emit(
      "app_mention",
      appMentionPayload({
        user: "U-ALICE",
        channel: "C-QA",
        text: "<@UBOTID> alice prompt",
        envelope_id: "env-alice",
      }),
    );
    // Yield so alice's worker reaches the gated llm.chat() before we
    // queue bob.
    await new Promise((res) => setImmediate(res));
    void h.socket.emit(
      "app_mention",
      appMentionPayload({
        user: "U-BOB",
        channel: "C-QA",
        text: "<@UBOTID> bob prompt",
        envelope_id: "env-bob",
      }),
    );
    // Let bob's worker start and reach its own llm.chat() (different
    // queue key from alice, so it runs in parallel).
    await new Promise((res) => setImmediate(res));

    assert.equal(
      h.llm.calls.length,
      2,
      "both workers should be in flight (different queue keys)",
    );

    // No busy / queued notice was posted (different users → different
    // queues → no contention).
    const contention = h.web.posted.find((p) =>
      /還在處理|排隊中/.test(p.text ?? ""),
    );
    assert.equal(contention, undefined, "no queue notice for different users");

    releaseFirst();
    await h.flush();

    assert.equal(h.web.updated.length, 2, "both final updates fire");
  });

  it("same user double-tap in same channel → second QUEUED, both processed in order", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    h.llm.script(
      async () => {
        await firstGate;
        return "first answer";
      },
      "second answer",
    );

    await h.adapter.start();

    void h.socket.emit(
      "app_mention",
      appMentionPayload({
        user: "U-ALICE",
        channel: "C-QA",
        text: "<@UBOTID> q1",
        envelope_id: "env-alice-1",
      }),
    );
    await new Promise((res) => setImmediate(res));
    // Same user + same channel + different envelope → queued behind q1.
    void h.socket.emit(
      "app_mention",
      appMentionPayload({
        user: "U-ALICE",
        channel: "C-QA",
        text: "<@UBOTID> q2 from same user",
        envelope_id: "env-alice-2",
      }),
    );
    await new Promise((res) => setImmediate(res));

    assert.equal(
      h.llm.calls.length,
      1,
      "second tap is queued; only q1's LLM call has started",
    );
    const queued = h.web.posted.find((p) =>
      /排入隊伍/.test(p.text ?? ""),
    );
    assert.ok(queued, "queued notice should fire when work is queued");
    assert.match(queued!.text ?? "", /你上一則還在處理/);

    releaseFirst();
    await h.flush();

    // Both turns processed in order.
    assert.equal(
      h.llm.calls.length,
      2,
      "after q1 drains, q2's LLM call fires",
    );
    assert.equal(h.web.updated.length, 2, "both final updates posted");
  });

  it("queue cap exceeded → rejection notice, work not enqueued", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    // Script enough replies for the running + 3 queued (cap default).
    h.llm.script(
      async () => {
        await firstGate;
        return "answer 1";
      },
      "answer 2",
      "answer 3",
      "answer 4",
    );

    await h.adapter.start();

    // 1st fires immediately (runs).
    void h.socket.emit(
      "app_mention",
      appMentionPayload({
        user: "U-ALICE",
        channel: "C-QA",
        text: "<@UBOTID> q1",
        envelope_id: "env-a1",
      }),
    );
    await new Promise((res) => setImmediate(res));
    // 2nd, 3rd, 4th queue behind (depth=1, 2, 3 — cap is 3 queued).
    void h.socket.emit(
      "app_mention",
      appMentionPayload({
        user: "U-ALICE",
        channel: "C-QA",
        text: "<@UBOTID> q2",
        envelope_id: "env-a2",
      }),
    );
    await new Promise((res) => setImmediate(res));
    void h.socket.emit(
      "app_mention",
      appMentionPayload({
        user: "U-ALICE",
        channel: "C-QA",
        text: "<@UBOTID> q3",
        envelope_id: "env-a3",
      }),
    );
    await new Promise((res) => setImmediate(res));
    void h.socket.emit(
      "app_mention",
      appMentionPayload({
        user: "U-ALICE",
        channel: "C-QA",
        text: "<@UBOTID> q4",
        envelope_id: "env-a4",
      }),
    );
    await new Promise((res) => setImmediate(res));
    // 5th rejected — queue full.
    void h.socket.emit(
      "app_mention",
      appMentionPayload({
        user: "U-ALICE",
        channel: "C-QA",
        text: "<@UBOTID> q5 over cap",
        envelope_id: "env-a5",
      }),
    );
    await new Promise((res) => setImmediate(res));

    const rejected = h.web.posted.find((p) =>
      /上限.*3.*則/.test(p.text ?? ""),
    );
    assert.ok(rejected, "queue-full rejection notice should fire");

    releaseFirst();
    await h.flush();

    // 4 LLM calls (q1 ran + q2/q3/q4 from queue) — q5 was rejected.
    assert.equal(h.llm.calls.length, 4);
  });

  it("two users' concurrent turns both land in the channel-log (race-free persistence)", async () => {
    // End-to-end proof that the v0.13 concurrency change + append-only
    // log together prevent the data-loss race the legacy
    // ChannelChatSession had: with the OLD model, Bob's loadChannel-
    // ChatSession would have snapshotted before Alice's save, then
    // Bob's saveChannelChatSession would have overwritten Alice's turn
    // on disk (Slack-side messages still posted, but channel context
    // would lose Alice's turn for future LLM calls).
    //
    // Post thread-split fix: a shared channel conversation is now a shared
    // THREAD (top-level mentions are isolated per-thread), so the race
    // scenario is two users mentioning concurrently IN THE SAME THREAD.
    const SHARED_THREAD = "1700000900.000009";
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    h.llm.script(
      async () => {
        await firstGate;
        return "alice answer";
      },
      "bob answer",
    );

    await h.adapter.start();

    void h.socket.emit(
      "app_mention",
      appMentionPayload({
        user: "U-ALICE",
        channel: "C-LOG",
        text: "<@UBOTID> alice prompt",
        ts: "1700000901.000001",
        thread_ts: SHARED_THREAD,
        envelope_id: "env-a",
      }),
    );
    await new Promise((res) => setImmediate(res));
    void h.socket.emit(
      "app_mention",
      appMentionPayload({
        user: "U-BOB",
        channel: "C-LOG",
        text: "<@UBOTID> bob prompt",
        ts: "1700000902.000002",
        thread_ts: SHARED_THREAD,
        envelope_id: "env-b",
      }),
    );
    await new Promise((res) => setImmediate(res));

    releaseFirst();
    await h.flush();

    const entries = loadChannelTurns("C-LOG", SHARED_THREAD);
    const userTurns = entries.filter((e) => e.role === "user" && e.userId);
    const userIds = userTurns.map((e) => e.userId);
    assert.ok(
      userIds.includes("U-ALICE"),
      "Alice's turn persisted in the log",
    );
    assert.ok(
      userIds.includes("U-BOB"),
      "Bob's turn persisted in the log",
    );
    assert.equal(userTurns.length, 2, "exactly two user-attributed turns");

    const assistantContents = entries
      .filter((e) => e.role === "assistant")
      .map((e) => e.content);
    assert.ok(assistantContents.some((c) => c.includes("alice answer")));
    assert.ok(assistantContents.some((c) => c.includes("bob answer")));
  });
});

describe("SlackAdapter integration: graceful shutdown drain (v0.13 #55)", () => {
  let h: Harness;

  beforeEach(() => {
    h = buildHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("stop() awaits in-flight queue work before broadcasting offline", async () => {
    let releaseLlm: () => void = () => {};
    const llmGate = new Promise<void>((resolve) => {
      releaseLlm = resolve;
    });
    h.llm.script(async () => {
      await llmGate;
      return "delayed answer";
    });

    await h.adapter.start();

    void h.socket.emit(
      "message",
      dmMessagePayload({
        user: "U-SHUTDOWN",
        channel: "D-SHUTDOWN",
        text: "ask before shutdown",
      }),
    );
    // Yield so the queue worker actually starts and reaches its LLM await.
    await new Promise((res) => setImmediate(res));

    // stop() must NOT race ahead of the queued turn; resolve the LLM
    // gate only after a short delay and prove stop() didn't return
    // before the final placeholder update landed.
    const stopStartedAt = Date.now();
    let stopResolved = false;
    const stopPromise = h.adapter.stop({ drainTimeoutMs: 5000 }).then(() => {
      stopResolved = true;
    });
    // Tick to let stop() reach its drain-await; it must still be pending.
    await new Promise((res) => setImmediate(res));
    assert.equal(
      stopResolved,
      false,
      "stop() must wait for in-flight queue work, not return immediately",
    );
    assert.equal(
      h.web.updated.length,
      0,
      "placeholder is still the thinking spinner — LLM hasn't returned",
    );

    releaseLlm();
    await stopPromise;
    const elapsed = Date.now() - stopStartedAt;
    assert.ok(elapsed < 5000, `stop() should resolve well before the timeout (took ${elapsed}ms)`);

    assert.equal(
      h.web.updated.length,
      1,
      "final placeholder update fired before stop() returned",
    );
    assert.match(h.web.updated[0].text ?? "", /delayed answer/);
  });

  it("a DM turn that finishes mid-drain posts the '服務重新啟動' restart notice to its thread", async () => {
    let releaseLlm: () => void = () => {};
    const llmGate = new Promise<void>((resolve) => {
      releaseLlm = resolve;
    });
    h.llm.script(async () => {
      await llmGate;
      return "delayed answer";
    });

    await h.adapter.start();

    void h.socket.emit(
      "message",
      dmMessagePayload({
        user: "U-SHUTDOWN",
        channel: "D-SHUTDOWN",
        text: "ask before shutdown",
        ts: "1700000900.000900",
      }),
    );
    // Let the worker reach its LLM await, THEN begin shutdown so the turn
    // observes shuttingDown=true when it finishes during the drain.
    await new Promise((res) => setImmediate(res));
    const stopPromise = h.adapter.stop({ drainTimeoutMs: 5000 });
    await new Promise((res) => setImmediate(res));

    releaseLlm();
    await stopPromise;

    const notice = h.web.posted.find((p) =>
      /服務重新啟動，預計 5–10 分鐘後重新上線/.test(p.text ?? ""),
    );
    assert.ok(notice, "the DM turn should post a restart notice when draining");
    assert.equal(notice!.channel, "D-SHUTDOWN", "notice goes to the DM channel");
    assert.equal(
      notice!.thread_ts,
      "1700000900.000900",
      "notice is threaded under the bot's reply (event.ts for a top-level DM)",
    );
  });

  it("a channel @-mention turn that finishes mid-drain posts the restart notice to its thread", async () => {
    let releaseLlm: () => void = () => {};
    const llmGate = new Promise<void>((resolve) => {
      releaseLlm = resolve;
    });
    h.llm.script(async () => {
      await llmGate;
      return "delayed answer";
    });

    await h.adapter.start();

    void h.socket.emit(
      "app_mention",
      appMentionPayload({
        user: "U-SHUTDOWN",
        channel: "C-SHUTDOWN",
        text: "<@UBOTID> ask before shutdown",
        ts: "1700000901.000901",
      }),
    );
    await new Promise((res) => setImmediate(res));
    const stopPromise = h.adapter.stop({ drainTimeoutMs: 5000 });
    await new Promise((res) => setImmediate(res));

    releaseLlm();
    await stopPromise;

    const notice = h.web.posted.find((p) =>
      /服務重新啟動，預計 5–10 分鐘後重新上線/.test(p.text ?? ""),
    );
    assert.ok(notice, "the mention turn should post a restart notice when draining");
    assert.equal(notice!.channel, "C-SHUTDOWN", "notice goes to the mention channel");
    assert.equal(
      notice!.thread_ts,
      "1700000901.000901",
      "notice is threaded under the bot's reply (event.ts for a top-level mention)",
    );
  });

  it("a normal turn (no shutdown) posts NO restart notice", async () => {
    h.llm.script("plain answer");
    await h.adapter.start();
    await h.socket.emit(
      "message",
      dmMessagePayload({ user: "U-OK", channel: "D-OK", text: "hi" }),
    );
    await h.flush();
    assert.ok(
      !h.web.posted.some((p) => /服務重新啟動/.test(p.text ?? "")),
      "no restart notice should be posted outside of shutdown",
    );
  });

  it("stop() honours drainTimeoutMs and logs when in-flight work blows the budget", async () => {
    const logs: string[] = [];
    h.cleanup();
    h = buildHarness({ onLog: (m) => logs.push(m) });
    // Never released — simulates a stuck LLM round that would otherwise
    // wedge SIGTERM until SIGKILL.
    h.llm.script(async () => {
      await new Promise<void>(() => {});
      return "never";
    });

    await h.adapter.start();

    void h.socket.emit(
      "message",
      dmMessagePayload({
        user: "U-STUCK",
        channel: "D-STUCK",
        text: "stuck turn",
      }),
    );
    await new Promise((res) => setImmediate(res));

    const startedAt = Date.now();
    await h.adapter.stop({ drainTimeoutMs: 80 });
    const elapsed = Date.now() - startedAt;

    assert.ok(
      elapsed >= 70 && elapsed < 1500,
      `stop() should resolve near the timeout (~80ms), got ${elapsed}ms`,
    );
    assert.ok(
      logs.some((l) => /drain timed out after 80ms/.test(l)),
      "shutdown should log the timeout so operators can see abandoned work",
    );
  });
});
