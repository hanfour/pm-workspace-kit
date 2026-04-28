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
  truncate,
} from "../src/gateway/messaging";
import { pickAudience, pickEscalationPool } from "../src/gateway/config";
import {
  pickGatewayPrompt,
  PROMPT_GATEWAY_DM_BIZ,
  PROMPT_GATEWAY_DM_EXEC,
  PROMPT_GATEWAY_DM_TECH,
} from "@pmk/shared";
import {
  formatAtomsForInjection,
  generateAtomId,
  knowledgeRoot,
  loadAtoms,
  safeScope,
  saveAtom,
  searchAtoms,
  slugifyQuestion,
} from "../src/gateway/knowledge";
import { extractKnowledgeAtom } from "../src/gateway/extractor";
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
