// packages/cli/test/review-coordinator.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { FakeWebClient } from "./harness/slack-fakes";
import { ReviewCoordinator, type ReviewGateway } from "../src/gateway/slack/review";
import { resolveReviewConfig } from "../src/gateway/config";

const ORIG_HOME = process.env.HOME; // gatewayDir() is HOME-based; isolate via HOME (not PMK_HOME)
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-rc-")); process.env.HOME = tmp; });
afterEach(() => { if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME; fs.rmSync(tmp, { recursive: true, force: true }); });

function gw(over: Partial<ReviewGateway> = {}): ReviewGateway {
  return {
    resolveProjectByRemote: () => "proj",
    getPrHead: async () => ({ sha: "headsha", baseRef: "main" }),
    repoVisibility: async () => "private",
    getAuthUser: async () => "expected-bot",
    ensureReviewWorkspaceMeta: () => {},
    prepareReviewClone: async () => ({ ok: true, cloneDir: path.join(tmp, "proj"), baseRef: "main" }),
    teardownReviewClone: () => {},
    runMraReview: async () => ({ ok: true, status: "CHANGES_REQUESTED", commentCount: 2, stdout: "", stderr: "" }),
    resolveRepoSlug: async () => "onead/OnePixel",
    ...over,
  } as unknown as ReviewGateway;
}

function coord(web: FakeWebClient, gateway: ReviewGateway) {
  const config = {
    version: 1 as const, admins: [], blocklist: [], audience: {} as never,
    escalation: {} as never, slack: {}, mraWorkspace: path.join(tmp, "ws"),
    review: { enabled: true, expectedGhUser: "expected-bot" },
  } as never;
  return new ReviewCoordinator({ web: web as never, config, onLog: () => {}, gateway });
}

describe("ReviewCoordinator.fromReaction", () => {
  it("happy path posts a Slack status with the review outcome", async () => {
    const web = new FakeWebClient();
    web.conversationsHistoryResponse = { ok: true, messages: [
      { text: "@r :cr: <https://github.com/onead/OnePixel/pull/12|#12>" },
    ] };
    await coord(web, gw()).fromReaction({ channelId: "C1", messageTs: "1.1", reactorUserId: "U1" });
    assert.ok(web.posted.some((p) => /CHANGES_REQUESTED|review|#12/.test(p.text ?? "")));
  });

  it("disabled config does nothing", async () => {
    const web = new FakeWebClient();
    const config = { version: 1, admins: [], blocklist: [], audience: {}, escalation: {}, slack: {},
      review: { enabled: false } } as never;
    const c = new ReviewCoordinator({ web: web as never, config, onLog: () => {}, gateway: gw() });
    await c.fromReaction({ channelId: "C1", messageTs: "1.1", reactorUserId: "U1" });
    assert.equal(web.posted.length, 0);
  });

  it("aborts a PR when gh actor != expectedGhUser (never posts as wrong identity)", async () => {
    const web = new FakeWebClient();
    web.conversationsHistoryResponse = { ok: true, messages: [
      { text: ":cr: https://github.com/onead/OnePixel/pull/12" } ] };
    let reviewed = false;
    await coord(web, gw({ getAuthUser: async () => "someone-else",
      runMraReview: async () => { reviewed = true; return { ok: true, stdout: "", stderr: "" }; } }))
      .fromReaction({ channelId: "C1", messageTs: "1.1", reactorUserId: "U1" });
    assert.equal(reviewed, false);
    assert.ok(web.posted.some((p) => /身分|identity|actor/i.test(p.text ?? "")));
  });

  it("public repo (guard on) is skipped", async () => {
    const web = new FakeWebClient();
    web.conversationsHistoryResponse = { ok: true, messages: [
      { text: ":cr: https://github.com/onead/OnePixel/pull/12" } ] };
    let reviewed = false;
    await coord(web, gw({ repoVisibility: async () => "public",
      runMraReview: async () => { reviewed = true; return { ok: true, stdout: "", stderr: "" }; } }))
      .fromReaction({ channelId: "C1", messageTs: "1.1", reactorUserId: "U1" });
    assert.equal(reviewed, false);
    assert.ok(web.posted.some((p) => /public/i.test(p.text ?? "")));
  });
});
