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
import { readGatewayEvents } from "../src/gateway/events";
import { saveUserSession } from "../src/gateway/session-store";
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

    // Atom file removed from disk.
    const after = loadAtoms({ promote: false });
    assert.equal(after.length, 0);

    const replies = h.web
      .postsTo(channelId)
      .filter((p) => p.thread_ts === messageTs);
    assert.equal(replies.length, 1);
    assert.match(replies[0].text ?? "", /捨棄/);
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

  it("stop() emits gateway.offline (always broadcasts; suppression is online-only)", async () => {
    h = buildHarness();
    await h.adapter.start();
    // Stop after start: broadcastOffline always fires the audit event
    // and posts the offline notice (the audit rationale is "operators
    // want to see the going-down notice even when the corresponding
    // back-up is suppressed").
    await h.adapter.stop();

    const offline = eventsOfType("gateway.offline");
    assert.equal(offline.length, 1);
    assert.equal(offline[0].broadcast, true);
    assert.equal(offline[0].reason, "shutdown");
  });
});

describe("SlackAdapter integration: msg_too_long hardening (v0.11.1)", () => {
  let h: Harness;

  /** Seed a paired DM history so `forcePruneToMinimum` has turns to drop. */
  function seedPairedHistory(userId: string) {
    saveUserSession({
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
    });
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
