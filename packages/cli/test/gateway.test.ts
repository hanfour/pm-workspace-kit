import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  GATEWAY_CONFIG_VERSION,
  hasValidSlackTokens,
  loadGatewayConfig,
  saveGatewayConfig,
} from "../src/gateway/config";
import {
  HEARTBEAT_STALE_MS,
  clearHeartbeat,
  startHeartbeat,
} from "../src/gateway/heartbeat";
import {
  clearThreadEscalation,
  listRecentChannels,
  listRecentUsers,
  loadChannelChatSession,
  loadChannelMeta,
  loadThreadEscalation,
  loadUserSession,
  saveChannelChatSession,
  saveChannelMeta,
  saveThreadEscalation,
  saveUserSession,
  userStats,
} from "../src/gateway/session-store";
import {
  formatBackOnlineNotice,
  formatOfflineNotice,
  formatTrackingSummary,
  markdownToMrkdwn,
  truncateForSlack,
} from "../src/gateway/formatters";
import { parseMraAsk, stripMraAskBlock } from "../src/gateway/mra-ask";
import { parseEscalate, stripEscalateBlock } from "../src/gateway/escalate";
import { mraDoctor, runMraAsk } from "../src/adapters/mra";
import {
  buildMraFailureMessage,
  buildMraSuccessMessage,
  KEEP_RECENT_TURNS,
  MAX_SESSION_TOKENS,
  pruneSessionIfNeeded,
  truncate,
} from "../src/gateway/messaging";
import type { ChatMessage } from "@pmk/shared";
import {
  pickAudience,
  pickEffectiveEscalationPool,
  pickEscalationPool,
} from "../src/gateway/config";
import {
  AUDIENCE_KEYS,
  pickGatewayPrompt,
  PROMPT_GATEWAY_DM_BIZ,
  PROMPT_GATEWAY_DM_EXEC,
  PROMPT_GATEWAY_DM_PM,
  PROMPT_GATEWAY_DM_TECH,
} from "@pmk/shared";
import {
  approveAtom,
  findAtomByApprovalMessage,
  formatAtomsForInjection,
  generateAtomId,
  knowledgeRoot,
  loadAtoms,
  rejectAtom,
  safeScope,
  saveAtom,
  searchAtoms,
  slugifyQuestion,
} from "../src/gateway/knowledge";
import {
  approvedAtomCount,
  buildAtomsIndex,
  searchAtomsRanked,
} from "../src/gateway/atom-index";
import { extractKnowledgeAtom } from "../src/gateway/extractor";
import { slashCommandArgsFromBody } from "../src/gateway/slack";
import type { LlmProvider } from "../src/llm";

const ORIG_HOME = process.env.HOME;
const ORIG_APP_TOKEN = process.env.PMK_SLACK_APP_TOKEN;
const ORIG_BOT_TOKEN = process.env.PMK_SLACK_BOT_TOKEN;

describe("gateway config", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-gw-cfg-"));
    process.env.HOME = tmpHome;
    delete process.env.PMK_SLACK_APP_TOKEN;
    delete process.env.PMK_SLACK_BOT_TOKEN;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
    if (ORIG_APP_TOKEN !== undefined)
      process.env.PMK_SLACK_APP_TOKEN = ORIG_APP_TOKEN;
    if (ORIG_BOT_TOKEN !== undefined)
      process.env.PMK_SLACK_BOT_TOKEN = ORIG_BOT_TOKEN;
  });

  it("returns empty config when file missing", () => {
    const cfg = loadGatewayConfig();
    assert.equal(cfg.version, GATEWAY_CONFIG_VERSION);
    assert.deepEqual(cfg.blocklist, []);
    assert.equal(cfg.slack.appToken, undefined);
    assert.equal(hasValidSlackTokens(cfg), false);
  });

  it("save → load round-trips", () => {
    const cfg = {
      version: 1 as const,
      blocklist: ["U-bad"],
      admins: [],
      defaultIngest: "mra:--all",
      audience: { default: "tech" as const, users: {} },
      escalation: { default: [], repos: {} },
      slack: { appToken: "xapp-foo", botToken: "xoxb-bar" },
    };
    saveGatewayConfig(cfg);
    const loaded = loadGatewayConfig();
    assert.equal(loaded.slack.appToken, "xapp-foo");
    assert.equal(loaded.slack.botToken, "xoxb-bar");
    assert.equal(loaded.defaultIngest, "mra:--all");
    assert.deepEqual(loaded.blocklist, ["U-bad"]);
    assert.equal(hasValidSlackTokens(loaded), true);
  });

  it("env vars override file values", () => {
    saveGatewayConfig({
      version: 1,
      blocklist: [],
      admins: [],
      audience: { default: "tech", users: {} },
      escalation: { default: [], repos: {} },
      slack: { appToken: "xapp-from-file", botToken: "xoxb-from-file" },
    });
    process.env.PMK_SLACK_APP_TOKEN = "xapp-from-env";
    process.env.PMK_SLACK_BOT_TOKEN = "xoxb-from-env";
    const loaded = loadGatewayConfig();
    assert.equal(loaded.slack.appToken, "xapp-from-env");
    assert.equal(loaded.slack.botToken, "xoxb-from-env");
  });

  it("hasValidSlackTokens rejects wrong prefixes", () => {
    assert.equal(
      hasValidSlackTokens({
        version: 1,
        blocklist: [],
        admins: [],
        audience: { default: "tech", users: {} },
        escalation: { default: [], repos: {} },
        slack: { appToken: "wrong", botToken: "xoxb-x" },
      }),
      false,
    );
    assert.equal(
      hasValidSlackTokens({
        version: 1,
        blocklist: [],
        admins: [],
        audience: { default: "tech", users: {} },
        escalation: { default: [], repos: {} },
        slack: { appToken: "xapp-x", botToken: "wrong" },
      }),
      false,
    );
  });

  it("legacy config (without audience/escalation) loads with defaults", () => {
    const file = path.join(tmpHome, ".pmk", "gateway.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          version: 1,
          blocklist: [],
          slack: { appToken: "xapp-x", botToken: "xoxb-x" },
        },
        null,
        2,
      ),
    );
    const loaded = loadGatewayConfig();
    assert.equal(loaded.audience.default, "tech");
    assert.deepEqual(loaded.audience.users, {});
    assert.deepEqual(loaded.escalation.default, []);
    assert.deepEqual(loaded.escalation.repos, {});
    assert.equal(loaded.mraWorkspace, undefined);
  });

  it("mraWorkspace round-trips through save/load", () => {
    saveGatewayConfig({
      version: 1,
      blocklist: [],
      admins: [],
      mraWorkspace: "/tmp/some/workspace",
      audience: { default: "tech", users: {} },
      escalation: { default: [], repos: {} },
      slack: { appToken: "xapp-x", botToken: "xoxb-x" },
    });
    const loaded = loadGatewayConfig();
    assert.equal(loaded.mraWorkspace, "/tmp/some/workspace");
  });

  it("PMK_MRA_WORKSPACE env var overrides config file", () => {
    const ORIG_WS = process.env.PMK_MRA_WORKSPACE;
    saveGatewayConfig({
      version: 1,
      blocklist: [],
      admins: [],
      mraWorkspace: "/from/file",
      audience: { default: "tech", users: {} },
      escalation: { default: [], repos: {} },
      slack: { appToken: "xapp-x", botToken: "xoxb-x" },
    });
    try {
      process.env.PMK_MRA_WORKSPACE = "/from/env";
      const loaded = loadGatewayConfig();
      assert.equal(loaded.mraWorkspace, "/from/env");
    } finally {
      if (ORIG_WS === undefined) delete process.env.PMK_MRA_WORKSPACE;
      else process.env.PMK_MRA_WORKSPACE = ORIG_WS;
    }
  });
});

describe("heartbeat", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-gw-hb-"));
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    clearHeartbeat();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  it("first start reports wasOffline=true (no prior heartbeat)", () => {
    const r = startHeartbeat();
    assert.equal(r.wasOffline, true);
    assert.equal(r.lastSeenAt, undefined);
    r.stop();
  });

  it("re-start within stale threshold reports wasOffline=false", () => {
    const r1 = startHeartbeat();
    r1.stop();
    const r2 = startHeartbeat();
    assert.equal(r2.wasOffline, false);
    assert.ok(r2.lastSeenAt && Date.now() - r2.lastSeenAt < HEARTBEAT_STALE_MS);
    r2.stop();
  });
});

describe("session-store", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-gw-store-"));
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  it("loadUserSession returns empty session for new user", () => {
    const s = loadUserSession("U-alice");
    assert.equal(s.userId, "U-alice");
    assert.deepEqual(s.messages, []);
    assert.equal(s.turns, 0);
  });

  it("saveUserSession + loadUserSession round-trips", () => {
    const s = loadUserSession("U-alice");
    s.messages.push({ role: "user", content: "hi" });
    s.turns = 1;
    s.approxTokens = 5;
    s.displayName = "Alice";
    saveUserSession(s);
    const loaded = loadUserSession("U-alice");
    assert.equal(loaded.turns, 1);
    assert.equal(loaded.approxTokens, 5);
    assert.equal(loaded.displayName, "Alice");
    assert.equal(loaded.messages[0].content, "hi");
    assert.ok(loaded.lastActiveAt > 0);
  });

  it("listRecentUsers filters by lastActiveAt", () => {
    const old = loadUserSession("U-old");
    saveUserSession(old);
    // Manually backdate the file (bypass saveUserSession which sets lastActiveAt=now).
    const dir = path.join(
      tmpHome,
      ".pmk",
      "gateway",
      "slack",
      "users",
      "U-old",
    );
    const file = path.join(dir, "session.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.lastActiveAt = Date.now() - 48 * 60 * 60 * 1000;
    fs.writeFileSync(file, JSON.stringify(data));

    const fresh = loadUserSession("U-fresh");
    saveUserSession(fresh);

    const recent = listRecentUsers(24);
    assert.deepEqual(recent.sort(), ["U-fresh"]);
  });

  it("channel chat session round-trips and starts empty", () => {
    const fresh = loadChannelChatSession("C-x");
    assert.equal(fresh.channelId, "C-x");
    assert.equal(fresh.messages.length, 0);
    assert.equal(fresh.turns, 0);
    fresh.messages.push({ role: "user", content: "hello channel" });
    fresh.turns = 1;
    fresh.approxTokens = 7;
    saveChannelChatSession(fresh);
    const reload = loadChannelChatSession("C-x");
    assert.equal(reload.turns, 1);
    assert.equal(reload.approxTokens, 7);
    assert.equal(reload.messages[0].content, "hello channel");
    assert.ok(reload.lastActiveAt > 0);
  });

  it("channel meta save → load + listRecentChannels", () => {
    const m = loadChannelMeta("C-debug");
    m.activeCase = "cue-checkbox";
    saveChannelMeta(m);
    const reload = loadChannelMeta("C-debug");
    assert.equal(reload.activeCase, "cue-checkbox");
    const recent = listRecentChannels(1);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].channelId, "C-debug");
  });

  it("userStats sorts by token usage descending", () => {
    const a = loadUserSession("U-a");
    a.approxTokens = 100;
    a.turns = 5;
    saveUserSession(a);
    const b = loadUserSession("U-b");
    b.approxTokens = 1000;
    b.turns = 3;
    saveUserSession(b);
    const stats = userStats(168);
    assert.equal(stats[0].userId, "U-b");
    assert.equal(stats[1].userId, "U-a");
  });
});

describe("formatters", () => {
  it("markdownToMrkdwn rewrites bold, headings, links", () => {
    assert.equal(markdownToMrkdwn("**bold** text"), "*bold* text");
    assert.equal(markdownToMrkdwn("# Heading"), "*Heading*");
    assert.equal(
      markdownToMrkdwn("see [docs](https://x.com)"),
      "see <https://x.com|docs>",
    );
  });

  it("markdownToMrkdwn strips case-update fenced blocks", () => {
    const input = "answer here\n\n```case-update\nhypothesis: x\n```";
    const out = markdownToMrkdwn(input);
    assert.ok(!out.includes("case-update"));
    assert.ok(out.startsWith("answer here"));
  });

  it("truncateForSlack adds ellipsis at the cap", () => {
    const big = "x".repeat(40_000);
    const out = truncateForSlack(big);
    assert.ok(out.length < 40_500);
    assert.match(out, /truncated by pmk/);
    assert.equal(truncateForSlack("short"), "short");
  });

  it("formatTrackingSummary returns null for empty input", () => {
    assert.equal(formatTrackingSummary([]), null);
    const s = formatTrackingSummary(["a", "b"]);
    assert.match(s ?? "", /pmk auto-tracked/);
    assert.match(s ?? "", /• a/);
    assert.match(s ?? "", /• b/);
  });

  it("formatBackOnlineNotice handles missing duration", () => {
    assert.match(formatBackOnlineNotice(), /重新上線/);
    assert.match(formatBackOnlineNotice(120_000), /約 2 分鐘/);
    // Sub-minute
    assert.match(formatBackOnlineNotice(5_000), /重新上線/);
  });

  it("formatOfflineNotice mentions host offline", () => {
    assert.match(formatOfflineNotice(), /暫離|host/);
  });
});

describe("mra-ask directive", () => {
  it("parseMraAsk extracts repo + question", () => {
    const r = parseMraAsk(
      [
        "I'll look up the campaign types in erp.",
        "",
        "```mra-ask",
        "repo: erp",
        "question: where is the sales_performances scope and what does it touch?",
        "```",
      ].join("\n"),
    );
    assert.ok(r);
    assert.equal(r?.repo, "erp");
    assert.match(r?.question ?? "", /sales_performances/);
  });

  it("parseMraAsk returns undefined when block missing", () => {
    assert.equal(parseMraAsk("nothing here"), undefined);
  });

  it("parseMraAsk returns undefined when required field missing", () => {
    const r = parseMraAsk("```mra-ask\nrepo: erp\n```");
    assert.equal(r, undefined);
  });

  it("stripMraAskBlock removes trailing fenced block", () => {
    const out = stripMraAskBlock(
      "answer here\n\n```mra-ask\nrepo: erp\nquestion: x\n```",
    );
    assert.ok(!out.includes("mra-ask"));
    assert.match(out, /^answer here/);
  });

  it("stripMraAskBlock removes mid-text fenced block", () => {
    const out = stripMraAskBlock(
      "intro\n\n```mra-ask\nrepo: erp\nquestion: x\n```\n\nmore",
    );
    assert.ok(!out.includes("mra-ask"));
    assert.match(out, /more/);
  });
});

describe("runMraAsk", () => {
  const ORIG_PROBE = process.env.PMK_SKIP_MRA_PROBE;
  afterEach(() => {
    if (ORIG_PROBE === undefined) delete process.env.PMK_SKIP_MRA_PROBE;
    else process.env.PMK_SKIP_MRA_PROBE = ORIG_PROBE;
  });

  it("returns ok=false with reason when mra binary not found", async () => {
    process.env.PMK_SKIP_MRA_PROBE = "1";
    const r = await runMraAsk({
      repo: "erp",
      question: "anything",
      cwd: process.cwd(),
    });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /not found/);
  });
});

describe("messaging helpers", () => {
  it("truncate is a no-op below the cap", () => {
    assert.equal(truncate("short", 100), "short");
  });

  it("truncate slices and appends a marker", () => {
    const out = truncate("a".repeat(200), 50);
    assert.equal(out.startsWith("a".repeat(50)), true);
    assert.match(out, /truncated 150 chars/);
  });

  it("buildMraSuccessMessage wraps stdout in mra-result fence", () => {
    const m = buildMraSuccessMessage(
      "erp",
      "module X lives at app/models/x.rb",
    );
    assert.match(m, /^這是 `mra ask erp`/);
    assert.match(m, /```mra-result\n/);
    assert.match(m, /app\/models\/x\.rb/);
  });

  it("buildMraSuccessMessage truncates very long stdout", () => {
    const big = "x".repeat(40_000);
    const m = buildMraSuccessMessage("erp", big);
    assert.ok(m.length < 30_000);
    assert.match(m, /truncated/);
  });

  it("buildMraFailureMessage uses 'unknown' when reason missing", () => {
    const m = buildMraFailureMessage("erp", { stdout: "", stderr: "" });
    assert.match(m, /失敗：unknown/);
    assert.ok(!m.includes("mra-stderr"));
    assert.ok(!m.includes("mra-partial-stdout"));
  });

  it("buildMraFailureMessage emits stderr fence when stderr present", () => {
    const m = buildMraFailureMessage("erp", {
      stdout: "",
      stderr: "PKB index not built; run `mra build erp` first.",
      reason: "exit 1",
    });
    assert.match(m, /失敗：exit 1/);
    assert.match(m, /```mra-stderr\n/);
    assert.match(m, /PKB index not built/);
  });

  it("buildMraFailureMessage emits partial-stdout fence when present", () => {
    const m = buildMraFailureMessage("erp", {
      stdout: "[ask] querying erp\nfound 3 results before crash",
      stderr: "",
      reason: "killed",
    });
    assert.match(m, /```mra-partial-stdout\n/);
    assert.match(m, /found 3 results/);
  });

  it("buildMraFailureMessage instructs model to cite stderr cause", () => {
    const m = buildMraFailureMessage("erp", {
      stdout: "",
      stderr: "rate limited",
    });
    assert.match(m, /引用上面 stderr 提到的具體原因/);
  });
});

describe("pruneSessionIfNeeded (#18)", () => {
  // Helper to build a session with N (user, assistant) pairs after an
  // optional PKB seed pair. Each message content is sized to push
  // approxTokens past MAX_SESSION_TOKENS.
  function makeSession(opts: {
    pairs: number;
    contentSize: number;
    withSeed: boolean;
  }) {
    const messages: ChatMessage[] = [];
    if (opts.withSeed) {
      messages.push({
        role: "user",
        content: `我先把 workspace 的 PKB context 給你（後續對話請用這些事實作答；缺的就老實說沒有，不要編造）：\n${"#".repeat(2_000)}`,
      });
      messages.push({
        role: "assistant",
        content: "了解，已載入 workspace PKB context。請繼續。",
      });
    }
    for (let i = 0; i < opts.pairs; i++) {
      messages.push({
        role: "user",
        content: `user turn ${i}: ${"x".repeat(opts.contentSize)}`,
      });
      messages.push({
        role: "assistant",
        content: `assistant turn ${i}: ${"y".repeat(opts.contentSize)}`,
      });
    }
    const totalChars = messages.reduce((n, m) => n + m.content.length, 0);
    return {
      messages,
      approxTokens: Math.ceil(totalChars / 3.5),
    };
  }

  it("no-op when under cap", () => {
    const session = makeSession({ pairs: 3, contentSize: 100, withSeed: true });
    const before = session.messages.length;
    const r = pruneSessionIfNeeded(session);
    assert.equal(r.pruned, false);
    assert.equal(session.messages.length, before);
  });

  it("prunes oldest pairs when over cap, preserves PKB seed + last K pairs", () => {
    // 60 pairs × 4 000 chars each ≈ 137k tokens — well over the 60k cap.
    const session = makeSession({
      pairs: 60,
      contentSize: 4_000,
      withSeed: true,
    });
    assert.ok(
      session.approxTokens > MAX_SESSION_TOKENS,
      "fixture should exceed cap",
    );

    const r = pruneSessionIfNeeded(session);
    assert.equal(r.pruned, true);
    assert.ok(r.droppedPairs > 0);

    // PKB seed retained
    assert.match(
      session.messages[0].content,
      /我先把 workspace 的 PKB context/,
    );
    assert.equal(session.messages[1].role, "assistant");

    // Marker inserted right after seed
    assert.match(session.messages[2].content, /^\(此處省略 \d+ 輪/);

    // Last KEEP_RECENT_TURNS pairs retained at the end
    const tail = session.messages.slice(-KEEP_RECENT_TURNS * 2);
    assert.equal(tail.length, KEEP_RECENT_TURNS * 2);
    assert.match(tail[0].content, /^user turn \d+/);

    // Token tally rebuilt
    assert.equal(r.tokensAfter, session.approxTokens);
    assert.ok(r.tokensAfter < MAX_SESSION_TOKENS, "post-prune still over cap");
  });

  it("idempotent on already-pruned session", () => {
    const session = makeSession({
      pairs: 60,
      contentSize: 4_000,
      withSeed: true,
    });
    pruneSessionIfNeeded(session);
    const lengthAfterFirstPrune = session.messages.length;

    // Run again immediately — should be a no-op.
    const second = pruneSessionIfNeeded(session);
    assert.equal(second.pruned, false);
    assert.equal(session.messages.length, lengthAfterFirstPrune);
  });

  it("prunes correctly when there is no PKB seed", () => {
    const session = makeSession({
      pairs: 60,
      contentSize: 4_000,
      withSeed: false,
    });
    assert.ok(session.approxTokens > MAX_SESSION_TOKENS);

    const r = pruneSessionIfNeeded(session);
    assert.equal(r.pruned, true);
    // First message is now the marker (no seed to preserve)
    assert.match(session.messages[0].content, /^\(此處省略 \d+ 輪/);
    // Last KEEP_RECENT_TURNS pairs retained
    const tail = session.messages.slice(-KEEP_RECENT_TURNS * 2);
    assert.equal(tail.length, KEEP_RECENT_TURNS * 2);
  });

  it("no-op when over cap but message count is small (single huge message)", () => {
    // Edge case: one absurdly long message can put us over cap with
    // nothing to prune. Should bail rather than mangle the array.
    const session: { messages: ChatMessage[]; approxTokens: number } = {
      messages: [{ role: "user", content: "x".repeat(MAX_SESSION_TOKENS * 4) }],
      approxTokens: MAX_SESSION_TOKENS + 1_000,
    };
    const r = pruneSessionIfNeeded(session);
    assert.equal(r.pruned, false);
    assert.equal(session.messages.length, 1);
  });
});

describe("runMraAsk retry-once", () => {
  const ORIG_PROBE = process.env.PMK_SKIP_MRA_PROBE;
  afterEach(() => {
    if (ORIG_PROBE === undefined) delete process.env.PMK_SKIP_MRA_PROBE;
    else process.env.PMK_SKIP_MRA_PROBE = ORIG_PROBE;
  });

  it("returns attempts=1 for binary-not-found (no retry)", async () => {
    process.env.PMK_SKIP_MRA_PROBE = "1";
    const r = await runMraAsk({
      repo: "erp",
      question: "anything",
      cwd: process.cwd(),
    });
    assert.equal(r.ok, false);
    assert.equal(r.attempts, 1);
  });
});

describe("mraDoctor workspace override", () => {
  let tmpHome: string;
  let validWs: string;
  let invalidWs: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-mra-doc-"));
    validWs = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-valid-ws-"));
    invalidWs = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-invalid-ws-"));
    fs.mkdirSync(path.join(validWs, ".collab"), { recursive: true });
    fs.writeFileSync(
      path.join(validWs, ".collab", "repos.json"),
      JSON.stringify({ repos: [] }),
    );
    process.env.HOME = tmpHome;
    // Need a binary on PATH; simulate by using the test runner's node.
    // Actual mra binary lookup is mocked via PMK_SKIP_MRA_PROBE=0 so we
    // exercise the binary-found branch via the FALLBACK_BIN_PATHS file
    // probe — easiest is to point at a real existing executable.
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(validWs, { recursive: true, force: true });
    fs.rmSync(invalidWs, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  it("explicit valid workspace short-circuits cwd walk", () => {
    const r = mraDoctor({ workspace: validWs, cwd: tmpHome });
    if (!r.ok) {
      // Test environment may lack a real `mra` binary; the workspace
      // logic still runs first, so the failure must be binary-not-found
      // rather than workspace-not-found.
      assert.match(r.reason ?? "", /not found/);
      return;
    }
    assert.equal(r.workspace, path.resolve(validWs));
  });

  it("explicit invalid workspace returns config-fix hint, doesn't fall through", () => {
    const r = mraDoctor({ workspace: invalidWs, cwd: tmpHome });
    if (r.ok) {
      // Shouldn't happen — but if it did, the override must still be respected.
      assert.fail(`expected failure but got ok with workspace=${r.workspace}`);
    }
    // When binary missing → "not found"; when binary present → workspace hint.
    // Either way the config-fix path must NOT silently fall through to cwd walk.
    const ok =
      /not found/.test(r.reason ?? "") ||
      /no \.collab\/repos\.json/.test(r.reason ?? "");
    assert.ok(ok, `unexpected reason: ${r.reason}`);
  });
});

describe("thread-aware sessions", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-gw-thread-"));
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  it("thread A and thread B have isolated histories", () => {
    const a = loadUserSession("U-x", "1700000000.111111");
    a.messages.push({ role: "user", content: "thread A msg" });
    saveUserSession(a, "1700000000.111111");

    const b = loadUserSession("U-x", "1700000099.222222");
    assert.equal(b.messages.length, 0);
    b.messages.push({ role: "user", content: "thread B msg" });
    saveUserSession(b, "1700000099.222222");

    const aReload = loadUserSession("U-x", "1700000000.111111");
    assert.equal(aReload.messages[0].content, "thread A msg");
    assert.equal(aReload.messages.length, 1);
  });

  it("main session is distinct from any thread", () => {
    const main = loadUserSession("U-y");
    main.messages.push({ role: "user", content: "main msg" });
    saveUserSession(main);

    const thread = loadUserSession("U-y", "1700000000.111111");
    assert.equal(thread.messages.length, 0);
  });

  it("channel chat thread/main isolation", () => {
    const main = loadChannelChatSession("C-z");
    main.messages.push({ role: "user", content: "channel main" });
    saveChannelChatSession(main);

    const thread = loadChannelChatSession("C-z", "ts-1");
    assert.equal(thread.messages.length, 0);
    thread.messages.push({ role: "user", content: "channel thread" });
    saveChannelChatSession(thread, "ts-1");

    const mainReload = loadChannelChatSession("C-z");
    assert.equal(mainReload.messages[0].content, "channel main");
    const threadReload = loadChannelChatSession("C-z", "ts-1");
    assert.equal(threadReload.messages[0].content, "channel thread");
  });
});

describe("audience picker", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-gw-aud-"));
    process.env.HOME = tmpHome;
    delete process.env.PMK_SLACK_APP_TOKEN;
    delete process.env.PMK_SLACK_BOT_TOKEN;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  it("falls back to default when no override", () => {
    const cfg = loadGatewayConfig();
    cfg.audience.default = "biz";
    saveGatewayConfig(cfg);
    const reload = loadGatewayConfig();
    assert.equal(pickAudience(reload, "U-anyone"), "biz");
  });

  it("user override beats default", () => {
    const cfg = loadGatewayConfig();
    cfg.audience.default = "tech";
    cfg.audience.users["U-exec1"] = "exec";
    saveGatewayConfig(cfg);
    const reload = loadGatewayConfig();
    assert.equal(pickAudience(reload, "U-exec1"), "exec");
    assert.equal(pickAudience(reload, "U-other"), "tech");
  });

  it("pickGatewayPrompt returns the right body per audience", () => {
    assert.equal(pickGatewayPrompt("tech"), PROMPT_GATEWAY_DM_TECH);
    assert.equal(pickGatewayPrompt("pm"), PROMPT_GATEWAY_DM_PM);
    assert.equal(pickGatewayPrompt("biz"), PROMPT_GATEWAY_DM_BIZ);
    assert.equal(pickGatewayPrompt("exec"), PROMPT_GATEWAY_DM_EXEC);
    // Unknown / undefined falls back to tech.
    assert.equal(pickGatewayPrompt(undefined), PROMPT_GATEWAY_DM_TECH);
  });

  it("biz prompt mentions business meaning, exec prompt mentions 結論/影響/建議行動", () => {
    assert.match(PROMPT_GATEWAY_DM_BIZ, /business|商業|業務|意義/);
    assert.match(PROMPT_GATEWAY_DM_EXEC, /結論/);
    assert.match(PROMPT_GATEWAY_DM_EXEC, /影響/);
    assert.match(PROMPT_GATEWAY_DM_EXEC, /建議行動/);
  });

  it("pm prompt has translation cheat-sheet + bans formulas in user-facing questions", () => {
    // Core role hint
    assert.match(PROMPT_GATEWAY_DM_PM, /senior PM helping another PM/);
    // Allows file:line refs (so PM can hand off to engineering)
    assert.match(PROMPT_GATEWAY_DM_PM, /file paths|model names/);
    // Forbids formulas / SQL in question-back-to-user form
    assert.match(PROMPT_GATEWAY_DM_PM, /No formulas|No SQL|No code blocks/);
    // Has the translation table example showing PM-language phrasing
    assert.match(PROMPT_GATEWAY_DM_PM, /對廣告主報的成本|網域.*版位/);
  });

  it("AUDIENCE_KEYS lists all 4 keys including pm", () => {
    assert.deepEqual([...AUDIENCE_KEYS], ["tech", "pm", "biz", "exec"]);
  });

  it("pickAudience honours per-user pm setting", () => {
    const cfg = loadGatewayConfig();
    cfg.audience.users["U_PM1"] = "pm";
    saveGatewayConfig(cfg);
    const reload = loadGatewayConfig();
    assert.equal(pickAudience(reload, "U_PM1"), "pm");
  });
});

describe("escalation pool picker", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-gw-esc-"));
    process.env.HOME = tmpHome;
    delete process.env.PMK_SLACK_APP_TOKEN;
    delete process.env.PMK_SLACK_BOT_TOKEN;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  it("repo pool wins over default; default is fallback", () => {
    const cfg = loadGatewayConfig();
    cfg.escalation.default = ["U_DEFAULT"];
    cfg.escalation.repos = { erp: ["U_ERP1", "U_ERP2"] };
    saveGatewayConfig(cfg);
    const reload = loadGatewayConfig();
    assert.deepEqual(pickEscalationPool(reload, "erp"), ["U_ERP1", "U_ERP2"]);
    assert.deepEqual(pickEscalationPool(reload, "unknown-repo"), ["U_DEFAULT"]);
    assert.deepEqual(pickEscalationPool(reload, undefined), ["U_DEFAULT"]);
  });

  // v0.8.2 (#30) — pickEffectiveEscalationPool drops the asker so we
  // never @-mention the person who just asked.
  it("pickEffectiveEscalationPool removes asker from the resolved pool", () => {
    const cfg = loadGatewayConfig();
    cfg.escalation.default = ["U_HOST"];
    cfg.escalation.repos = { erp: ["U_HOST", "U_IT1", "U_IT2"] };
    saveGatewayConfig(cfg);
    const reload = loadGatewayConfig();
    // Asker is in the repo pool — should drop self, keep U_IT1, U_IT2.
    assert.deepEqual(pickEffectiveEscalationPool(reload, "erp", "U_HOST"), [
      "U_IT1",
      "U_IT2",
    ]);
    // Asker is the only one in the default pool — effective pool empty.
    assert.deepEqual(
      pickEffectiveEscalationPool(reload, "unknown-repo", "U_HOST"),
      [],
    );
    // Asker not in pool at all — pool unchanged.
    assert.deepEqual(pickEffectiveEscalationPool(reload, "erp", "U_OTHER"), [
      "U_HOST",
      "U_IT1",
      "U_IT2",
    ]);
  });

  it("pickEffectiveEscalationPool returns [] when both pool branches are empty", () => {
    const cfg = loadGatewayConfig();
    cfg.escalation.default = [];
    cfg.escalation.repos = {};
    saveGatewayConfig(cfg);
    const reload = loadGatewayConfig();
    assert.deepEqual(pickEffectiveEscalationPool(reload, "erp", "U_X"), []);
    assert.deepEqual(pickEffectiveEscalationPool(reload, undefined, "U_X"), []);
  });
});

describe("escalate directive", () => {
  it("parses repo + question + reason", () => {
    const r = parseEscalate(
      [
        "I'll ask the IT team.",
        "",
        "```escalate",
        "repo: erp",
        "question: What's the live state of campaign X?",
        "reason: not in PKB; live ops state.",
        "```",
      ].join("\n"),
    );
    assert.ok(r);
    assert.equal(r?.repo, "erp");
    assert.match(r?.question ?? "", /live state/);
    assert.match(r?.reason ?? "", /not in PKB/);
  });

  it("repo is optional", () => {
    const r = parseEscalate(
      ["```escalate", "question: who owns billing?", "```"].join("\n"),
    );
    assert.ok(r);
    assert.equal(r?.repo, undefined);
    assert.match(r?.question ?? "", /billing/);
  });

  it("returns undefined when block missing or question missing", () => {
    assert.equal(parseEscalate("nothing"), undefined);
    assert.equal(parseEscalate("```escalate\nrepo: erp\n```"), undefined);
  });

  it("stripEscalateBlock removes the block", () => {
    const out = stripEscalateBlock(
      "preamble\n\n```escalate\nrepo: erp\nquestion: X\n```",
    );
    assert.ok(!out.includes("escalate"));
    assert.match(out, /^preamble/);
  });
});

describe("knowledge store", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-knowledge-"));
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  it("slugifyQuestion produces filesystem-safe slugs (CJK + ASCII)", () => {
    assert.match(slugifyQuestion("AdFormat 怎麼設定？"), /adformat/);
    assert.equal(slugifyQuestion("AdFormat 怎麼設定？").includes(" "), false);
  });

  it("save → load round-trips fields", () => {
    const id = generateAtomId("AdFormat 怎麼設定");
    saveAtom({
      id,
      createdAt: 1700000000000,
      scope: "erp",
      question: "AdFormat 怎麼設定？",
      answer: "三層結構：AdFormat → AdFormatType → SubAdType。",
      summary: "AdFormat 是版型大類；AdFormatType 是具體變體。",
      tags: ["adformat", "版型"],
      source: { threadKey: "C1:t1", contributorUserId: "U_IT1" },
    });
    const atoms = loadAtoms({ scope: "erp" });
    assert.equal(atoms.length, 1);
    assert.equal(atoms[0].question, "AdFormat 怎麼設定？");
    assert.equal(atoms[0].source.contributorUserId, "U_IT1");
    assert.deepEqual(atoms[0].tags, ["adformat", "版型"]);
  });

  it("searchAtoms ranks question+tag matches above body-only", () => {
    saveAtom({
      id: generateAtomId("widget A"),
      createdAt: 1700000000000,
      scope: "erp",
      question: "How is widget A configured?",
      answer: "Configured via X.",
      summary: "Widget A configuration overview.",
      tags: ["widget"],
      source: { threadKey: "T1", contributorUserId: "U1" },
    });
    saveAtom({
      id: generateAtomId("Note about widgets in passing"),
      createdAt: 1700000010000,
      scope: "erp",
      question: "Unrelated topic about reports",
      answer: "But widget appears here too.",
      summary: "Reports overview.",
      tags: ["report"],
      source: { threadKey: "T2", contributorUserId: "U1" },
    });
    const hits = searchAtoms("widget configured", { limit: 2 });
    assert.equal(hits.length, 2);
    assert.match(hits[0].question, /widget A/);
  });

  it("formatAtomsForInjection produces a labelled context block", () => {
    saveAtom({
      id: generateAtomId("q"),
      createdAt: 1700000000000,
      scope: "erp",
      question: "Q?",
      answer: "A.",
      summary: "S.",
      tags: ["t1"],
      source: { threadKey: "T1", contributorUserId: "U1" },
    });
    const atoms = loadAtoms({ scope: "erp" });
    const out = formatAtomsForInjection(atoms);
    assert.match(out, /ground truth/);
    assert.match(out, /Q\?/);
    assert.match(out, /A\./);
  });

  it("formatAtomsForInjection returns empty string when no atoms", () => {
    assert.equal(formatAtomsForInjection([]), "");
  });

  it("safeScope rejects path traversal", () => {
    assert.equal(safeScope("../../etc/passwd"), "etc-passwd");
    assert.equal(safeScope("../foo"), "foo");
    assert.equal(safeScope("./.."), "general");
    assert.equal(safeScope(""), "general");
    assert.equal(safeScope(undefined), "general");
    assert.equal(safeScope("erp"), "erp");
    assert.equal(safeScope("repo-with-dash"), "repo-with-dash");
  });

  it("saveAtom sanitises a malicious scope so files stay under knowledge root", () => {
    saveAtom({
      id: generateAtomId("evil"),
      createdAt: 1700000000000,
      scope: "../../tmp/oops",
      question: "evil?",
      answer: "should never escape sandbox",
      summary: "x",
      tags: [],
      source: { threadKey: "T1", contributorUserId: "U1" },
    });
    // The escaped target should not exist…
    assert.equal(fs.existsSync(path.join(tmpHome, "tmp", "oops")), false);
    // …and the atom should land under the sanitised scope name.
    const sanitisedDir = path.join(knowledgeRoot(), "tmp-oops");
    assert.equal(fs.existsSync(sanitisedDir), true);
    const atoms = loadAtoms({ scope: "tmp-oops" });
    assert.equal(atoms.length, 1);
    assert.equal(atoms[0].scope, "tmp-oops");
  });

  it("parseEscalate strips path-traversal characters from repo", () => {
    const r = parseEscalate("```escalate\nrepo: ../../etc\nquestion: q\n```");
    assert.ok(r);
    // path separators stripped, leaving safe ASCII
    assert.equal(r?.repo, "etc");
  });

  it("atom round-trips with newlines and quotes in fields", () => {
    saveAtom({
      id: generateAtomId("multiline"),
      createdAt: 1700000000000,
      scope: "general",
      question: 'Question with "quotes" and a colon: like this',
      answer: 'Line one.\nLine two with "quotes".\nLine three: with a colon.',
      summary: 'Summary with "quotes"\nand a newline.',
      tags: ["multiline", "quotes"],
      source: { threadKey: "T1", contributorUserId: "U1" },
    });
    const atoms = loadAtoms({ scope: "general" });
    assert.equal(atoms.length, 1);
    assert.match(atoms[0].question, /quotes/);
    assert.match(atoms[0].answer, /Line one/);
    assert.match(atoms[0].answer, /Line three/);
  });
});

describe("atom TTL approval", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-atom-ttl-"));
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  it("pending atoms are excluded from searchAtoms", () => {
    saveAtom({
      id: generateAtomId("pending widget"),
      createdAt: Date.now(),
      scope: "erp",
      question: "How is widget configured?",
      answer: "Pending answer about widget setup.",
      summary: "Widget pending summary.",
      tags: ["widget"],
      source: { threadKey: "T1", contributorUserId: "U_IT1" },
      status: "pending",
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });
    const hits = searchAtoms("widget", { limit: 5 });
    assert.equal(hits.length, 0);
  });

  it("approved atoms are visible to searchAtoms", () => {
    saveAtom({
      id: generateAtomId("approved widget"),
      createdAt: Date.now(),
      scope: "erp",
      question: "How is widget configured?",
      answer: "Approved answer about widget setup.",
      summary: "Widget summary.",
      tags: ["widget"],
      source: { threadKey: "T1", contributorUserId: "U_IT1" },
      status: "approved",
    });
    const hits = searchAtoms("widget", { limit: 5 });
    assert.equal(hits.length, 1);
  });

  it("legacy atoms (no status field on disk) are treated as approved", () => {
    // Simulate v0.7.3 atom: write a markdown file without `status`
    // in the front-matter and ensure searchAtoms still finds it.
    const dir = path.join(knowledgeRoot(), "erp");
    fs.mkdirSync(dir, { recursive: true });
    const id = generateAtomId("legacy widget");
    fs.writeFileSync(
      path.join(dir, `${id}.md`),
      `---\nid: ${id}\ncreatedAt: 1700000000000\nscope: erp\nquestion: How is widget legacy?\ntags: [widget]\nsource:\n  threadKey: T-old\n  contributorUserId: U_OLD\n---\n# How is widget legacy?\n\n## Answer\n\nLegacy answer about widget.\n`,
    );
    const hits = searchAtoms("widget", { limit: 5 });
    assert.equal(hits.length, 1);
    assert.match(hits[0].question, /legacy/);
  });

  it("loadAtoms auto-promotes pending atoms past expiresAt", () => {
    const id = generateAtomId("expired pending");
    saveAtom({
      id,
      createdAt: Date.now() - 25 * 60 * 60 * 1000,
      scope: "erp",
      question: "expired question",
      answer: "expired answer",
      summary: "expired summary",
      tags: ["expired"],
      source: { threadKey: "T1", contributorUserId: "U_IT1" },
      status: "pending",
      expiresAt: Date.now() - 60_000, // already expired
    });
    // First load triggers auto-promote.
    loadAtoms({ scope: "erp" });
    // Second load reads the rewritten atom — should now be approved
    // and visible to retrieval.
    const hits = searchAtoms("expired", { limit: 5 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].status, "approved");
    assert.equal(hits[0].expiresAt, undefined);
  });

  it("approveAtom by id-prefix promotes pending → approved", () => {
    const id = generateAtomId("approve me");
    saveAtom({
      id,
      createdAt: Date.now(),
      scope: "erp",
      question: "approve me?",
      answer: "yes",
      summary: "promote test",
      tags: ["t"],
      source: { threadKey: "T1", contributorUserId: "U1" },
      status: "pending",
      expiresAt: Date.now() + 60_000,
    });
    // Use a unique short prefix from the id.
    const prefix = id.slice(0, 12);
    const promoted = approveAtom(prefix);
    assert.ok(promoted);
    assert.equal(promoted?.status, "approved");
    assert.equal(promoted?.expiresAt, undefined);
    // After approve, retrieval finds it.
    const hits = searchAtoms("approve", { limit: 5 });
    assert.equal(hits.length, 1);
  });

  it("rejectAtom by id-prefix deletes the file", () => {
    const id = generateAtomId("reject me");
    saveAtom({
      id,
      createdAt: Date.now(),
      scope: "erp",
      question: "reject me?",
      answer: "no",
      summary: "reject test",
      tags: ["t"],
      source: { threadKey: "T1", contributorUserId: "U1" },
      status: "pending",
      expiresAt: Date.now() + 60_000,
    });
    const ok = rejectAtom(id.slice(0, 12));
    assert.equal(ok, true);
    const atoms = loadAtoms();
    assert.equal(atoms.length, 0);
  });

  it("approveAtom returns undefined when prefix matches multiple atoms", () => {
    // Two atoms whose ids share a prefix because generateAtomId uses
    // a timestamp; force collision by using identical timestamps.
    const sharedPrefix = "20990101T0000000-aaaa";
    saveAtom({
      id: `${sharedPrefix}-one`,
      createdAt: Date.now(),
      scope: "erp",
      question: "one",
      answer: "a",
      summary: "s",
      tags: [],
      source: { threadKey: "T1", contributorUserId: "U1" },
      status: "pending",
      expiresAt: Date.now() + 60_000,
    });
    saveAtom({
      id: `${sharedPrefix}-two`,
      createdAt: Date.now(),
      scope: "erp",
      question: "two",
      answer: "b",
      summary: "s",
      tags: [],
      source: { threadKey: "T1", contributorUserId: "U1" },
      status: "pending",
      expiresAt: Date.now() + 60_000,
    });
    const r = approveAtom(sharedPrefix);
    assert.equal(r, undefined);
  });
});

describe("atom-index BM25 (#19)", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-atomidx-"));
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  function seedThreeApprovedAtoms() {
    saveAtom({
      id: generateAtomId("widget config"),
      createdAt: Date.now(),
      scope: "erp",
      question: "How is widget A configured for the campaign flow?",
      answer:
        "Widget A is configured via the campaign settings page; uses placement_id as primary grain.",
      summary:
        "Widget A configuration overview — campaign settings page, placement_id grain.",
      tags: ["widget", "campaign", "configuration"],
      source: { threadKey: "T1", contributorUserId: "U1" },
      status: "approved",
    });
    saveAtom({
      id: generateAtomId("budget allocation"),
      createdAt: Date.now() - 1000,
      scope: "erp",
      question: "How is the monthly budget allocated across departments?",
      answer:
        "Budget allocation lives in placement_revenues; query by month and department.",
      summary: "Monthly budget allocation across departments.",
      tags: ["budget", "allocation", "monthly", "placement_revenues"],
      source: { threadKey: "T2", contributorUserId: "U1" },
      status: "approved",
    });
    saveAtom({
      id: generateAtomId("pending unindexed"),
      createdAt: Date.now() - 2000,
      scope: "erp",
      question: "This atom should never appear in the index.",
      answer: "It is pending and BM25 must skip it.",
      summary: "pending excluded sentinel",
      tags: ["pending"],
      source: { threadKey: "T3", contributorUserId: "U1" },
      status: "pending",
      expiresAt: Date.now() + 60_000,
    });
  }

  it("buildAtomsIndex includes only approved atoms (skips pending)", () => {
    seedThreeApprovedAtoms();
    const idx = buildAtomsIndex({ scope: "erp" });
    assert.equal(idx.chunks.length, 2);
    // Verify the pending atom isn't in the chunk list
    const ids = idx.chunks.map((c) => c.id);
    const pendingAtom = loadAtoms({ scope: "erp" }).find(
      (a) => a.status === "pending",
    );
    assert.ok(pendingAtom);
    assert.equal(
      ids.includes(pendingAtom.id),
      false,
      "pending atom should not be in index",
    );
  });

  it("searchAtomsRanked returns BM25-ordered approved atoms", () => {
    seedThreeApprovedAtoms();
    const hits = searchAtomsRanked("budget allocation", {
      scope: "erp",
      limit: 5,
    });
    assert.ok(hits.length >= 1);
    // Top result should be the budget atom
    assert.match(hits[0].question, /budget/i);
    // Pending atom must not appear
    assert.ok(hits.every((a) => a.status === "approved"));
  });

  it("approvedAtomCount excludes pending", () => {
    seedThreeApprovedAtoms();
    assert.equal(approvedAtomCount("erp"), 2);
  });

  it("index file is rebuilt when atoms change (mtime invalidation)", () => {
    seedThreeApprovedAtoms();
    const first = buildAtomsIndex({ scope: "erp" });
    const firstBuiltAt = new Date(first.builtAt).getTime();
    // Add another atom AFTER the index built; mtime should now be newer
    // than firstBuiltAt, triggering a rebuild on next searchAtomsRanked.
    fs.utimesSync(
      path.join(knowledgeRoot(), "erp"),
      new Date(),
      new Date(firstBuiltAt + 60_000), // dir mtime well after index
    );
    saveAtom({
      id: generateAtomId("late addition"),
      createdAt: Date.now(),
      scope: "erp",
      question: "Late-added atom about budget reporting",
      answer: "More info on budget allocation reports.",
      summary: "Budget reporting details added later.",
      tags: ["budget", "reporting"],
      source: { threadKey: "T4", contributorUserId: "U1" },
      status: "approved",
    });
    const hits = searchAtomsRanked("budget", { scope: "erp", limit: 5 });
    // Late-added atom is now retrievable.
    assert.ok(hits.length >= 2);
    assert.ok(hits.some((a) => a.question.includes("Late-added")));
  });
});

describe("findAtomByApprovalMessage (#21)", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-react-approval-"));
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  it("finds atom by approval anchor (channelId + messageTs)", () => {
    saveAtom({
      id: generateAtomId("with anchor"),
      createdAt: Date.now(),
      scope: "erp",
      question: "anchored question?",
      answer: "anchored answer",
      summary: "s",
      tags: ["t"],
      source: { threadKey: "T1", contributorUserId: "U_IT1" },
      status: "pending",
      expiresAt: Date.now() + 60_000,
      approval: { channelId: "C1", messageTs: "1700000000.123456" },
    });
    const found = findAtomByApprovalMessage("C1", "1700000000.123456");
    assert.ok(found);
    assert.match(found?.atom.question ?? "", /anchored/);
  });

  it("returns undefined when no atom matches the anchor", () => {
    saveAtom({
      id: generateAtomId("anchor mismatch"),
      createdAt: Date.now(),
      scope: "erp",
      question: "q",
      answer: "a",
      summary: "s",
      tags: ["t"],
      source: { threadKey: "T1", contributorUserId: "U1" },
      status: "pending",
      expiresAt: Date.now() + 60_000,
      approval: { channelId: "C1", messageTs: "1700000000.111111" },
    });
    assert.equal(findAtomByApprovalMessage("C1", "wrong-ts"), undefined);
    assert.equal(
      findAtomByApprovalMessage("wrong-channel", "1700000000.111111"),
      undefined,
    );
  });

  it("returns undefined for legacy atoms without approval anchor", () => {
    // Atom written before v0.8.5 — no `approval` in front-matter.
    saveAtom({
      id: generateAtomId("legacy no anchor"),
      createdAt: Date.now(),
      scope: "erp",
      question: "legacy?",
      answer: "legacy answer",
      summary: "s",
      tags: ["t"],
      source: { threadKey: "T1", contributorUserId: "U1" },
      status: "approved",
    });
    assert.equal(findAtomByApprovalMessage("any-channel", "any-ts"), undefined);
  });

  it("approval anchor round-trips through save/load", () => {
    const id = generateAtomId("round trip anchor");
    saveAtom({
      id,
      createdAt: Date.now(),
      scope: "erp",
      question: "round trip?",
      answer: "answer",
      summary: "s",
      tags: ["t"],
      source: { threadKey: "T1", contributorUserId: "U1" },
      status: "pending",
      expiresAt: Date.now() + 60_000,
      approval: { channelId: "C-X", messageTs: "1700000000.999999" },
    });
    const atoms = loadAtoms({ scope: "erp" });
    assert.equal(atoms.length, 1);
    assert.deepEqual(atoms[0].approval, {
      channelId: "C-X",
      messageTs: "1700000000.999999",
    });
  });
});

describe("extractKnowledgeAtom", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-extract-"));
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  function stubLlm(reply: string): LlmProvider {
    return {
      name: "anthropic-api",
      displayName: "stub",
      async chat() {
        return reply;
      },
    };
  }

  it("parses a clean JSON reply into an atom", async () => {
    const llm = stubLlm(
      JSON.stringify({
        question: "What is X?",
        summary: "X is a thing.",
        tags: ["tag1", "tag2"],
      }),
    );
    const atom = await extractKnowledgeAtom(llm, {
      question: "what is X",
      expertAnswer: "X is a thing in our system.",
      scope: "erp",
      threadKey: "C1:t1",
      contributorUserId: "U_IT1",
    });
    assert.ok(atom);
    assert.equal(atom?.question, "What is X?");
    assert.equal(atom?.summary, "X is a thing.");
    assert.deepEqual(atom?.tags, ["tag1", "tag2"]);
    assert.equal(atom?.scope, "erp");
    assert.equal(atom?.source.contributorUserId, "U_IT1");
  });

  it("salvages JSON wrapped in a fenced code block", async () => {
    const llm = stubLlm(
      'Sure, here:\n```json\n{ "question": "Q?", "summary": "S.", "tags": ["t"] }\n```',
    );
    const atom = await extractKnowledgeAtom(llm, {
      question: "q",
      expertAnswer: "a",
      scope: "general",
      threadKey: "C:t",
      contributorUserId: "U",
    });
    assert.ok(atom);
    assert.equal(atom?.summary, "S.");
  });

  it("returns undefined on malformed JSON", async () => {
    const llm = stubLlm("not json at all");
    const atom = await extractKnowledgeAtom(llm, {
      question: "q",
      expertAnswer: "a",
      scope: "general",
      threadKey: "C:t",
      contributorUserId: "U",
    });
    assert.equal(atom, undefined);
  });

  it("returns undefined on missing required field", async () => {
    const llm = stubLlm(JSON.stringify({ question: "Q?" }));
    const atom = await extractKnowledgeAtom(llm, {
      question: "q",
      expertAnswer: "a",
      scope: "general",
      threadKey: "C:t",
      contributorUserId: "U",
    });
    assert.equal(atom, undefined);
  });

  it("sanitises malicious scope on output", async () => {
    const llm = stubLlm(
      JSON.stringify({ question: "Q?", summary: "S.", tags: [] }),
    );
    const atom = await extractKnowledgeAtom(llm, {
      question: "q",
      expertAnswer: "a",
      scope: "../../tmp/evil",
      threadKey: "C:t",
      contributorUserId: "U",
    });
    assert.ok(atom);
    assert.equal(atom?.scope, "tmp-evil");
  });
});

describe("thread escalation marker", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-gw-pending-"));
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  it("save → load → clear", () => {
    saveThreadEscalation({
      channelId: "C1",
      threadTs: "ts-1",
      question: "Q?",
      scope: "erp",
      pendingSince: Date.now(),
      mentionedUserIds: ["U_IT1"],
    });
    const got = loadThreadEscalation("C1", "ts-1");
    assert.ok(got);
    assert.equal(got?.scope, "erp");
    assert.deepEqual(got?.mentionedUserIds, ["U_IT1"]);

    clearThreadEscalation("C1", "ts-1");
    assert.equal(loadThreadEscalation("C1", "ts-1"), undefined);
  });

  it("returns undefined for unknown thread", () => {
    assert.equal(loadThreadEscalation("C0", "nope"), undefined);
  });
});

// ─────────────────────────── v0.9.0 admin (#31) ───────────────────────────

describe("isAdmin + admins back-fill (#31)", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-admin-"));
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  it("default empty admins → isAdmin returns false", async () => {
    const { isAdmin } = await import("../src/gateway/config");
    const cfg = loadGatewayConfig();
    assert.deepEqual(cfg.admins, []);
    assert.equal(isAdmin(cfg, "U-anyone"), false);
  });

  it("isAdmin true only for listed Slack user IDs", async () => {
    const { isAdmin } = await import("../src/gateway/config");
    const cfg = loadGatewayConfig();
    cfg.admins = ["U_OWNER", "U_OPS"];
    saveGatewayConfig(cfg);
    const reload = loadGatewayConfig();
    assert.equal(isAdmin(reload, "U_OWNER"), true);
    assert.equal(isAdmin(reload, "U_OPS"), true);
    assert.equal(isAdmin(reload, "U_RAND"), false);
  });

  it("legacy config without admins field back-fills to []", async () => {
    const { isAdmin } = await import("../src/gateway/config");
    const file = path.join(tmpHome, ".pmk", "gateway.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          version: 1,
          blocklist: [],
          audience: { default: "tech", users: {} },
          escalation: { default: [], repos: {} },
          slack: { appToken: "xapp-x", botToken: "xoxb-x" },
        },
        null,
        2,
      ),
    );
    const loaded = loadGatewayConfig();
    assert.deepEqual(loaded.admins, []);
    assert.equal(isAdmin(loaded, "U-anyone"), false);
  });
});

describe("admin-log (#31)", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-admin-log-"));
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  it("appendAdminLog → readAdminLog round-trips one entry", async () => {
    const { appendAdminLog, readAdminLog } =
      await import("../src/gateway/admin-log");
    appendAdminLog({
      actor: "U_OWNER",
      origin: "slack",
      action: "audience.set",
      args: "U_X pm",
      ok: true,
    });
    const entries = readAdminLog();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].actor, "U_OWNER");
    assert.equal(entries[0].action, "audience.set");
    assert.equal(entries[0].ok, true);
  });

  it("readAdminLog returns [] when file missing (no log written yet)", async () => {
    const { readAdminLog } = await import("../src/gateway/admin-log");
    assert.deepEqual(readAdminLog(), []);
  });

  it("readAdminLog tails to the requested limit (newest last)", async () => {
    const { appendAdminLog, readAdminLog } =
      await import("../src/gateway/admin-log");
    for (let i = 0; i < 30; i++) {
      appendAdminLog({
        actor: "cli:test",
        origin: "cli",
        action: "audit",
        args: `n=${i}`,
        ok: true,
      });
    }
    const tail = readAdminLog(5);
    assert.equal(tail.length, 5);
    assert.equal(tail[0].args, "n=25");
    assert.equal(tail[4].args, "n=29");
  });

  it("malformed lines are skipped, well-formed lines still parse", async () => {
    const { appendAdminLog, readAdminLog, adminLogPath } =
      await import("../src/gateway/admin-log");
    appendAdminLog({
      actor: "U_X",
      origin: "slack",
      action: "status",
      ok: true,
    });
    fs.appendFileSync(adminLogPath(), "this is not json\n");
    appendAdminLog({
      actor: "U_X",
      origin: "slack",
      action: "audience.list",
      ok: true,
    });
    const entries = readAdminLog();
    // Two valid + one garbage; readAdminLog must skip the garbage rather
    // than throw or short-circuit.
    assert.equal(entries.length, 2);
    assert.equal(entries[0].action, "status");
    assert.equal(entries[1].action, "audience.list");
  });

  it("audit-log write failure is non-fatal", async () => {
    // Point HOME at a path that cannot be created (file occupies the dir).
    const blocking = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-block-"));
    fs.writeFileSync(path.join(blocking, ".pmk"), "not a directory");
    process.env.HOME = blocking;
    const { appendAdminLog } = await import("../src/gateway/admin-log");
    // Must not throw even though mkdir/write under .pmk will fail.
    appendAdminLog({
      actor: "U_X",
      origin: "slack",
      action: "status",
      ok: true,
    });
    fs.rmSync(blocking, { recursive: true, force: true });
  });

  it("admin.log writes go to a YYYY-MM partition; legacy admin.log is read-only", async () => {
    const { appendAdminLog, readAdminLog, adminLogPath } = await import(
      "../src/gateway/admin-log"
    );
    const gatewayDir = path.join(tmpHome, ".pmk", "gateway");
    fs.mkdirSync(gatewayDir, { recursive: true });
    // Drop a legacy v0.10-era line that pre-dates partitioning.
    const legacy = path.join(gatewayDir, "admin.log");
    fs.writeFileSync(
      legacy,
      JSON.stringify({
        at: new Date().toISOString(),
        actor: "U_LEGACY",
        origin: "cli",
        action: "audience.list",
        ok: true,
      }) + "\n",
    );
    // New write goes to the partition file, not the legacy one.
    appendAdminLog({
      actor: "U_NEW",
      origin: "slack",
      action: "audience.list",
      ok: true,
    });
    assert.match(
      path.basename(adminLogPath()),
      /^admin-\d{4}-\d{2}\.log$/,
      "current-month partition path",
    );
    // Legacy file untouched (still 1 line).
    const legacyLines = fs.readFileSync(legacy, "utf8").trim().split("\n");
    assert.equal(legacyLines.length, 1);
    // Reader merges both — legacy line first (oldest tier), partition second.
    const all = readAdminLog();
    assert.equal(all.length, 2);
    assert.equal(all[0].actor, "U_LEGACY");
    assert.equal(all[1].actor, "U_NEW");
  });
});

describe("Slack admin handler (#31)", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-slack-admin-"));
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  it("extractUserId handles <@U…> mention, <@U…|name>, bare U…, garbage", async () => {
    const { extractUserId } = await import("../src/gateway/slack/admin");
    assert.equal(extractUserId("<@U0XYZ>"), "U0XYZ");
    assert.equal(extractUserId("<@U0XYZ|hanfour>"), "U0XYZ");
    assert.equal(extractUserId("U0XYZ"), "U0XYZ");
    assert.equal(extractUserId("WABCDEF"), "WABCDEF");
    assert.equal(extractUserId("not-a-user"), undefined);
    assert.equal(extractUserId(""), undefined);
  });

  it("help (no args) returns the command list", async () => {
    const { handleAdminSlash } = await import("../src/gateway/slack/admin");
    const r = await handleAdminSlash({ actor: "U_OWNER", tokens: [] });
    assert.match(r.text, /pmk admin commands/);
    assert.match(r.text, /audience set/);
    assert.match(r.text, /admins add/);
  });

  it("unknown subcommand returns help with the unknown name", async () => {
    const { handleAdminSlash } = await import("../src/gateway/slack/admin");
    const r = await handleAdminSlash({
      actor: "U_OWNER",
      tokens: ["wat"],
    });
    assert.match(r.text, /未知的 admin 子指令/);
    assert.match(r.text, /`wat`/);
  });

  it("audience set @user pm mutates per-user override", async () => {
    const { handleAdminSlash } = await import("../src/gateway/slack/admin");
    // Seed an admin so the trust path mirrors prod (handler trusts caller).
    const cfg = loadGatewayConfig();
    cfg.admins = ["U0OWNER"];
    saveGatewayConfig(cfg);

    const r = await handleAdminSlash({
      actor: "U0OWNER",
      tokens: ["audience", "set", "<@U0TARGET>", "pm"],
    });
    assert.match(r.text, /audience set to `pm`/);

    const reload = loadGatewayConfig();
    assert.equal(reload.audience.users["U0TARGET"], "pm");
  });

  it("audience set rejects invalid audience key", async () => {
    const { handleAdminSlash } = await import("../src/gateway/slack/admin");
    const r = await handleAdminSlash({
      actor: "U0OWNER",
      tokens: ["audience", "set", "<@U0TGT>", "not-a-tier"],
    });
    assert.match(r.text, /invalid audience/);
    const reload = loadGatewayConfig();
    assert.equal(reload.audience.users["U0TGT"], undefined);
  });

  it("admins remove blocks last-admin removal", async () => {
    const { handleAdminSlash } = await import("../src/gateway/slack/admin");
    const cfg = loadGatewayConfig();
    cfg.admins = ["U0ONLY"];
    saveGatewayConfig(cfg);

    const r = await handleAdminSlash({
      actor: "U0ONLY",
      tokens: ["admins", "remove", "<@U0ONLY>"],
    });
    assert.match(r.text, /cannot remove last admin/);
    const reload = loadGatewayConfig();
    assert.deepEqual(reload.admins, ["U0ONLY"]);
  });

  it("admins add then remove succeeds when ≥2 admins remain", async () => {
    const { handleAdminSlash } = await import("../src/gateway/slack/admin");
    const cfg = loadGatewayConfig();
    cfg.admins = ["U0OWNER"];
    saveGatewayConfig(cfg);

    const add = await handleAdminSlash({
      actor: "U0OWNER",
      tokens: ["admins", "add", "<@U0NEW>"],
    });
    assert.match(add.text, /added to admins/);
    const afterAdd = loadGatewayConfig();
    assert.deepEqual(afterAdd.admins.sort(), ["U0NEW", "U0OWNER"]);

    const remove = await handleAdminSlash({
      actor: "U0OWNER",
      tokens: ["admins", "remove", "<@U0NEW>"],
    });
    assert.match(remove.text, /removed from admins/);
    const afterRemove = loadGatewayConfig();
    assert.deepEqual(afterRemove.admins, ["U0OWNER"]);
  });

  it("admins add rejects non-Slack-id input", async () => {
    const { handleAdminSlash } = await import("../src/gateway/slack/admin");
    const r = await handleAdminSlash({
      actor: "U_OWNER",
      tokens: ["admins", "add", "alice@example.com"],
    });
    assert.match(r.text, /usage:/);
    const reload = loadGatewayConfig();
    assert.deepEqual(reload.admins, []);
  });

  it("audit subcommand surfaces recent log entries", async () => {
    const { handleAdminSlash } = await import("../src/gateway/slack/admin");
    const { appendAdminLog } = await import("../src/gateway/admin-log");
    appendAdminLog({
      actor: "U_OWNER",
      origin: "slack",
      action: "audience.set",
      args: "U_T pm",
      ok: true,
    });
    appendAdminLog({
      actor: "U_OWNER",
      origin: "slack",
      action: "admins.remove",
      args: "U_ONLY",
      ok: false,
      reason: "last-admin protection",
    });
    const r = await handleAdminSlash({
      actor: "U_OWNER",
      tokens: ["audit"],
    });
    assert.match(r.text, /admin audit/);
    assert.match(r.text, /audience\.set/);
    assert.match(r.text, /last-admin protection/);
  });

  it("escalation add @user appends to default pool", async () => {
    const { handleAdminSlash } = await import("../src/gateway/slack/admin");
    const r = await handleAdminSlash({
      actor: "U0OWNER",
      tokens: ["escalation", "add", "default", "<@U0IT1>"],
    });
    assert.match(r.text, /added/);
    const reload = loadGatewayConfig();
    assert.deepEqual(reload.escalation.default, ["U0IT1"]);
  });

  it("escalation add to a repo pool isolates it from default", async () => {
    const { handleAdminSlash } = await import("../src/gateway/slack/admin");
    await handleAdminSlash({
      actor: "U0OWNER",
      tokens: ["escalation", "add", "erp", "<@U0IT1>"],
    });
    const reload = loadGatewayConfig();
    assert.deepEqual(reload.escalation.repos["erp"], ["U0IT1"]);
    assert.deepEqual(reload.escalation.default, []);
  });
});

// ─────────────────────── v0.9.1 slash_commands (#39) ────────────────────────

describe("slashCommandArgsFromBody (#39)", () => {
  it("DM channel id (D…) → user scope, args trimmed", () => {
    const args = slashCommandArgsFromBody({
      user_id: "U0OWNER",
      channel_id: "D0DMCHAN",
      text: "  admin help  ",
    });
    assert.ok(args);
    assert.equal(args?.userId, "U0OWNER");
    assert.equal(args?.channelId, "D0DMCHAN");
    assert.equal(args?.rest, "admin help");
    assert.deepEqual(args?.scope, { kind: "user", userId: "U0OWNER" });
  });

  it("non-DM channel (C…) → channel scope", () => {
    const args = slashCommandArgsFromBody({
      user_id: "U0HX",
      channel_id: "C0CHAN",
      text: "help",
    });
    assert.ok(args);
    assert.deepEqual(args?.scope, { kind: "channel", channelId: "C0CHAN" });
  });

  it("empty text routes to help (so /pmk alone is discoverable)", () => {
    const args = slashCommandArgsFromBody({
      user_id: "U0X",
      channel_id: "D0X",
      text: "",
    });
    assert.equal(args?.rest, "help");
  });

  it("missing text field also routes to help", () => {
    const args = slashCommandArgsFromBody({
      user_id: "U0X",
      channel_id: "D0X",
    });
    assert.equal(args?.rest, "help");
  });

  it("missing user_id → null (envelope dropped)", () => {
    assert.equal(
      slashCommandArgsFromBody({ channel_id: "D0X", text: "help" }),
      null,
    );
  });

  it("missing channel_id → null (envelope dropped)", () => {
    assert.equal(
      slashCommandArgsFromBody({ user_id: "U0X", text: "help" }),
      null,
    );
  });

  it("undefined body → null", () => {
    assert.equal(slashCommandArgsFromBody(undefined), null);
  });

  it("DM-only check is downstream — /pmk admin in a channel still reaches the handler with channel scope", () => {
    // The body→args helper itself doesn't enforce DM-only; the
    // `case "admin"` branch in handleSlashCommand does. This test
    // documents that boundary so a future refactor doesn't accidentally
    // gate at the wrong layer.
    const args = slashCommandArgsFromBody({
      user_id: "U0X",
      channel_id: "C0PUBLIC",
      text: "admin status",
    });
    assert.ok(args);
    assert.equal(args?.scope.kind, "channel");
  });
});
