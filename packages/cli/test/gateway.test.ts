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
  listRecentChannels,
  listRecentUsers,
  loadChannelMeta,
  loadUserSession,
  saveChannelMeta,
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
        slack: { appToken: "wrong", botToken: "xoxb-x" },
      }),
      false,
    );
    assert.equal(
      hasValidSlackTokens({
        version: 1,
        blocklist: [],
        slack: { appToken: "xapp-x", botToken: "wrong" },
      }),
      false,
    );
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
    const dir = path.join(tmpHome, ".pmk", "gateway", "slack", "users", "U-old");
    const file = path.join(dir, "session.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.lastActiveAt = Date.now() - 48 * 60 * 60 * 1000;
    fs.writeFileSync(file, JSON.stringify(data));

    const fresh = loadUserSession("U-fresh");
    saveUserSession(fresh);

    const recent = listRecentUsers(24);
    assert.deepEqual(recent.sort(), ["U-fresh"]);
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
