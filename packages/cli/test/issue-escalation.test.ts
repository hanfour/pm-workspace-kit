import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WebClient } from "@slack/web-api";
import { EscalationCoordinator } from "../src/gateway/slack/escalation";
import { loadIssueCandidate } from "../src/gateway/issue-candidate";
import { GATEWAY_CONFIG_VERSION, type GatewayConfig } from "../src/gateway/config";
import type { LlmProvider } from "../src/llm";

const baseConfig = (): GatewayConfig => ({
  version: GATEWAY_CONFIG_VERSION,
  admins: [],
  blocklist: [],
  audience: { default: "biz", users: {}, channels: {}, domainExamples: { biz: [], pm: [] } },
  escalation: { default: ["U-IT"], repos: {} },
  slack: {},
});

function fakeWeb(rec: { posts: unknown[]; updates: unknown[]; permalinkThrows?: boolean }): WebClient {
  let n = 0;
  return {
    chat: {
      postMessage: async (a: unknown) => {
        rec.posts.push(a);
        n += 1;
        return { ok: true, ts: `200.${n}`, channel: "C1" };
      },
      update: async (a: unknown) => {
        rec.updates.push(a);
        return { ok: true };
      },
      getPermalink: async () => {
        if (rec.permalinkThrows) throw new Error("no scope");
        return { ok: true, permalink: "https://slack/permalink" };
      },
    },
  } as unknown as WebClient;
}

const fakeLlm = (): LlmProvider => ({}) as unknown as LlmProvider;

const coord = (web: WebClient) =>
  new EscalationCoordinator({ web, config: baseConfig(), onLog: () => {}, llm: fakeLlm() });

describe("escalate writes an issue-candidate", () => {
  let home: string;
  const orig = process.env.HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-iss-esc-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    if (orig !== undefined) process.env.HOME = orig;
  });

  it("with a repo: stores snapshot (diagnosis+permalink) and appends 🎫 via chat.update", async () => {
    const rec = { posts: [] as unknown[], updates: [] as unknown[] };
    await coord(fakeWeb(rec)).escalate({
      channelId: "C1",
      threadTs: "100.1",
      askerUserId: "U-ASK",
      diagnosis: "root cause at a.rb:10",
      request: { repo: "erp", question: "why broken" },
    });
    const c = loadIssueCandidate("C1", "200.1");
    assert.ok(c, "candidate written");
    assert.equal(c?.diagnosis, "root cause at a.rb:10");
    assert.equal(c?.scope, "erp");
    assert.deepEqual(c?.mentionedUserIds, ["U-IT"]);
    assert.equal(c?.permalink, "https://slack/permalink");
    assert.equal(rec.updates.length, 1);
  });

  it("without a repo: NO candidate, NO chat.update (no dead 🎫)", async () => {
    const rec = { posts: [] as unknown[], updates: [] as unknown[] };
    await coord(fakeWeb(rec)).escalate({
      channelId: "C1",
      threadTs: "100.1",
      askerUserId: "U-ASK",
      diagnosis: "d",
      request: { question: "why broken" },
    });
    assert.equal(loadIssueCandidate("C1", "200.1"), undefined);
    assert.equal(rec.updates.length, 0);
    assert.equal(rec.posts.length, 1);
  });

  it("permalink failure is best-effort: candidate still written without permalink", async () => {
    const rec = { posts: [] as unknown[], updates: [] as unknown[], permalinkThrows: true };
    await coord(fakeWeb(rec)).escalate({
      channelId: "C1",
      threadTs: "100.1",
      askerUserId: "U-ASK",
      diagnosis: "d",
      request: { repo: "erp", question: "q" },
    });
    const c = loadIssueCandidate("C1", "200.1");
    assert.ok(c);
    assert.equal(c?.permalink, undefined);
  });
});
