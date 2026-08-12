// packages/cli/test/review-coordinator.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { FakeWebClient } from "./harness/slack-fakes";
import { ReviewCoordinator, effectiveMraReviewStrategy, isReviewRequest, isRetryRequest, isRerunRequest, isApproveRequest, isApproveConfirmationRequest, isReviewCommandMissingPr, canConfirmApproveFromReview, reviewResultText, approveResultText, describeMraFailure, protectionNotReadyMessage, type ReviewGateway } from "../src/gateway/slack/review";
import { gatewayConfigPath, resolveReviewConfig, saveGatewayConfig } from "../src/gateway/config";

// Never point HOME back at the operator's home. Test files run in separate
// processes, so restoring buys nothing — and it opens a window that has
// already caused an outage: a cancelled test's abandoned continuation resumes
// AFTER afterEach, sees the real HOME, and writes to the live ~/.pmk. On
// 2026-08-04 that overwrote the gateway config with test fixtures and took
// the bot down. ORIG_HOME is a throwaway directory, never the real one.
const ORIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-safe-home-"));
process.env.HOME = ORIG_HOME; // gatewayDir() is HOME-based; isolate via HOME (not PMK_HOME)
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-rc-")); process.env.HOME = tmp; });
afterEach(() => { process.env.HOME = ORIG_HOME; fs.rmSync(tmp, { recursive: true, force: true }); });

function gw(over: Partial<ReviewGateway> = {}): ReviewGateway {
  return {
    resolveProjectByRemote: () => "proj",
    listPrDiscussion: async () => [],
    getPrHead: async () => ({ sha: "headsha", baseRef: "main" }),
    repoVisibility: async () => "private",
    getAuthUser: async () => "expected-bot",
    approvalProtectionReady: async () => true,
    reviewGateStatus: async () => true,
    createPullRequestApproval: async (a: { commitId: string }) => ({ reviewId: 99, state: "APPROVED", commitId: a.commitId, actor: "expected-bot" }),
    createPullRequestReview: async (a: { commitId: string; event: string }) => ({ reviewId: 98, state: a.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED", commitId: a.commitId, actor: "expected-bot" }),
    ensureReviewWorkspaceMeta: () => {},
    prepareReviewClone: async () => ({ ok: true, cloneDir: path.join(tmp, "proj"), baseRef: "main" }),
    teardownReviewClone: () => {},
    runMraReview: async () => ({ ok: true, status: "CHANGES_REQUESTED", commentCount: 2, stdout: "", stderr: "" }),
    runMraAnalyze: async () => ({ ok: true, stdout: "", stderr: "" }),
    pkbNeedsBuild: () => false,
    resolveRepoSlug: async () => "onead/OnePixel",
    ...over,
  } as unknown as ReviewGateway;
}

function coord(web: FakeWebClient, gateway: ReviewGateway, onLog: (m: string) => void = () => {}, reviewOverrides: Record<string, unknown> = {}) {
  const config = {
    version: 1 as const, admins: ["U1"], blocklist: [], audience: {} as never,
    escalation: {} as never, slack: {}, mraWorkspace: path.join(tmp, "ws"),
    review: { enabled: true, approval: { enabled: true }, expectedGhUser: "expected-bot", ...reviewOverrides },
  } as never;
  // sleep is a no-op in tests so the transient-failure retry backoff doesn't wait.
  return new ReviewCoordinator({ web: web as never, config, onLog, gateway, sleep: async () => {} });
}

function eligibleReviewResult(headSha = "headsha") {
  return {
    ok: true, status: "COMMENT", commentCount: 0, blockerCount: 0,
    protocolVersion: "1.0" as const, artifactSha256: "a".repeat(64), analyzedHeadSha: headSha,
    stdout: "", stderr: "",
  };
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

  it("builds the PKB BEFORE reviewing when the main clone has none (so the review is complete)", async () => {
    const web = new FakeWebClient();
    web.conversationsHistoryResponse = { ok: true, messages: [
      { text: "@r :cr: <https://github.com/onead/OnePixel/pull/12|#12>" },
    ] };
    let analyzed = false, builtBeforeReview = false;
    await coord(web, gw({
      pkbNeedsBuild: () => true,
      runMraAnalyze: async () => { analyzed = true; return { ok: true, stdout: "", stderr: "" }; },
      runMraReview: async () => { builtBeforeReview = analyzed; return { ok: true, status: "APPROVED", stdout: "", stderr: "" }; },
    }), () => {}, { providerMode: "claude" }).fromReaction({ channelId: "C1", messageTs: "1.1", reactorUserId: "U1" });
    assert.equal(analyzed, true, "a missing PKB must be built");
    assert.equal(builtBeforeReview, true, "the PKB build must run BEFORE the review");
  });

  it("does NOT rebuild the PKB when it is already fresh + valid", async () => {
    const web = new FakeWebClient();
    web.conversationsHistoryResponse = { ok: true, messages: [
      { text: "@r :cr: <https://github.com/onead/OnePixel/pull/12|#12>" },
    ] };
    let analyzed = false;
    await coord(web, gw({
      pkbNeedsBuild: () => false,
      runMraAnalyze: async () => { analyzed = true; return { ok: true, stdout: "", stderr: "" }; },
    })).fromReaction({ channelId: "C1", messageTs: "1.1", reactorUserId: "U1" });
    assert.equal(analyzed, false, "a fresh PKB must not be rebuilt");
  });

  it("actor-verify uses host-ambient identity (no token passed to getAuthUser)", async () => {
    // Even when a work token is resolvable, getAuthUser must be called with NO token
    // because runMraReview strips GH_TOKEN/GITHUB_TOKEN — mra posts under the host ambient identity.
    const web = new FakeWebClient();
    web.conversationsHistoryResponse = { ok: true, messages: [
      { text: "@r :cr: <https://github.com/onead/OnePixel/pull/12|#12>" },
    ] };
    let capturedGetAuthUserOpts: Record<string, unknown> | undefined;
    const gateway = gw({
      getAuthUser: async (opts) => {
        capturedGetAuthUserOpts = opts as Record<string, unknown>;
        return "expected-bot";
      },
    });
    await coord(web, gateway).fromReaction({ channelId: "C1", messageTs: "1.1", reactorUserId: "U1" });
    assert.ok(capturedGetAuthUserOpts !== undefined, "getAuthUser should have been called");
    assert.equal(
      capturedGetAuthUserOpts!["token"],
      undefined,
      "getAuthUser must NOT receive a token — mra posts under host-ambient identity",
    );
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
    // gh-actor skip happens after the progress bar is created, so the warning
    // arrives via progress.finish() → chat.update (web.updated), not a new postMessage.
    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(allTexts.some((t) => /身分|identity|actor/i.test(t)));
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
    // public-repo skip happens after the progress bar is created, so the warning
    // arrives via progress.finish() → chat.update (web.updated), not a new postMessage.
    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(allTexts.some((t) => /public/i.test(t)));
  });
});

// A message that OPENS with :cr: / :a: is a command attempt. Without a PR ref
// the typed classifiers both return false, and the message fell through to
// free-chat -- where the LLM answered from its own vocabulary and told a Slack
// user that "/code-review 需要指定一個 PR 才能啟動". /code-review is a Claude
// Code command, not a pmk surface; the classifier gap leaked internal tooling
// into a user-facing answer. Observed live 2026-08-03 (two consecutive turns).
// An `:a:` with no offer yet runs a REVIEW first and delegates to the review
// path, which owns both the wording and the audit line. Two consequences the
// user saw live: the result told them ":cr: 不會主動 approve" when they had
// typed `:a:`, and the audit recorded only intent=review, so an `:a:`-initiated
// run is indistinguishable from a plain `:cr:` after the fact.
describe("reviewResultText — names the command the user actually typed", () => {
  const ref = { owner: "o", repo: "r", number: 7, url: "https://github.com/o/r/pull/7" };
  const approvable = {
    ok: true, protocolVersion: "1.0" as const, artifactSha256: "a".repeat(64),
    analyzedHeadSha: "b".repeat(40), blockerCount: 0, status: "COMMENT",
    commentCount: 0, stdout: "", stderr: "",
  };

  it("says :cr: for a :cr:-initiated review", () => {
    const text = reviewResultText("o/r", ref, approvable, true, false, "cr");
    assert.match(text, /`:cr:` 不會主動 approve/);
    assert.ok(!/`:a:` 不會主動 approve/.test(text));
  });

  it("says :a: for an :a:-initiated pre-review", () => {
    const text = reviewResultText("o/r", ref, approvable, true, false, "a");
    assert.match(text, /`:a:` 不會主動 approve/);
    assert.ok(!/`:cr:` 不會主動 approve/.test(text));
  });

  it("defaults to :cr: when the origin is not supplied", () => {
    assert.match(reviewResultText("o/r", ref, approvable), /`:cr:`/);
  });
});

describe("isReviewCommandMissingPr (classifier fall-through guard)", () => {
  it("catches a bare command token", () => {
    assert.equal(isReviewCommandMissingPr(":cr:"), true);
    assert.equal(isReviewCommandMissingPr(":a:"), true);
    assert.equal(isReviewCommandMissingPr("  :cr:  "), true);
  });

  it("catches a command token with an unusable argument", () => {
    assert.equal(isReviewCommandMissingPr(":cr: 4914"), true);
    assert.equal(isReviewCommandMissingPr(":a: 那個 PR"), true);
  });

  it("does NOT catch a command that carries a PR (the typed path owns it)", () => {
    assert.equal(
      isReviewCommandMissingPr(":cr: https://github.com/o/r/pull/1"),
      false,
    );
    assert.equal(
      isReviewCommandMissingPr(":a: https://github.com/o/r/pull/1"),
      false,
    );
  });

  // Ordinary chat that merely mentions the token must stay in free-chat --
  // answering it with usage help would be its own kind of hijack.
  it("does NOT catch a mid-sentence mention", () => {
    assert.equal(isReviewCommandMissingPr("我剛用 :cr: 審過了"), false);
    assert.equal(isReviewCommandMissingPr("請問 :a: 是什麼意思"), false);
    assert.equal(isReviewCommandMissingPr("hello"), false);
  });
});

describe("isReviewRequest (inline :cr: gate)", () => {
  it("true when :cr: AND a PR link are present", () => {
    assert.equal(isReviewRequest(":cr: https://github.com/o/r/pull/1"), true);
    assert.equal(
      isReviewRequest("@reviewer :cr: <https://github.com/o/r/pull/9|#9> thanks"),
      true,
    );
  });
  it("false for a PR link WITHOUT :cr: (no false-firing on stray links)", () => {
    assert.equal(isReviewRequest("see https://github.com/o/r/pull/1 plz"), false);
  });
  it("false for :cr: WITHOUT a PR link", () => {
    assert.equal(isReviewRequest(":cr: looks good to me"), false);
  });
  it("false for neither / empty", () => {
    assert.equal(isReviewRequest("hello"), false);
    assert.equal(isReviewRequest(""), false);
  });
});

describe("isApproveRequest (inline :a: gate)", () => {
  it("true when :a: AND a PR link are present", () => {
    assert.equal(
      isApproveRequest(":a: https://github.com/onead/superdsp-ui/pull/547"),
      true,
    );
    assert.equal(
      isApproveRequest("@reviewer :a: <https://github.com/onead/superdsp-ui/pull/547|#547> lgtm"),
      true,
    );
  });
  it("false for :a: WITHOUT a PR link", () => {
    assert.equal(isApproveRequest(":a: no pr here"), false);
  });
  it("false for a PR link WITHOUT :a:", () => {
    assert.equal(
      isApproveRequest("https://github.com/onead/superdsp-ui/pull/547"),
      false,
    );
  });
  it("false for neither / empty", () => {
    assert.equal(isApproveRequest("hello"), false);
    assert.equal(isApproveRequest(""), false);
  });
});

describe("ReviewCoordinator.fromMessage (B-lite inline trigger)", () => {
  it("reviews from inline text WITHOUT a conversations.history fetch", async () => {
    const web = new FakeWebClient();
    // Make history throw — proves fromMessage uses the provided text, not a fetch.
    web.conversations.history = async () => {
      throw new Error("fromMessage must not call conversations.history");
    };
    await coord(web, gw()).fromMessage({
      channelId: "C1",
      threadTs: "1.1",
      userId: "U1",
      text: ":cr: https://github.com/onead/OnePixel/pull/12",
    });
    assert.ok(
      web.posted.some((p) => /CHANGES_REQUESTED|review|#12/.test(p.text ?? "")),
    );
  });

  it("disabled config does nothing", async () => {
    const web = new FakeWebClient();
    const config = {
      version: 1, admins: [], blocklist: [], audience: {}, escalation: {},
      slack: {}, mraWorkspace: path.join(tmp, "ws"), review: { enabled: false },
    } as never;
    const c = new ReviewCoordinator({ web: web as never, config, onLog: () => {}, gateway: gw() });
    await c.fromMessage({
      channelId: "C1", threadTs: "1.1", userId: "U1",
      text: ":cr: https://github.com/onead/OnePixel/pull/12",
    });
    assert.equal(web.posted.length, 0);
  });

  it("isEnabled() reflects config", () => {
    const web = new FakeWebClient();
    assert.equal(coord(web, gw()).isEnabled(), true);
  });
});

describe("ReviewCoordinator pinned ghToken threading", () => {
  it("uses review.ghToken for PMK GitHub checks but never passes it to MRA", async () => {
    const web = new FakeWebClient();
    let authOpts: { token?: string } | undefined;
    let mraArgs: { ghToken?: string } | undefined;
    const gateway = gw({
      getAuthUser: async (opts: { token?: string }) => {
        authOpts = opts;
        return "expected-bot";
      },
      runMraReview: async (a: { ghToken?: string }) => {
        mraArgs = a;
        return { ok: true, status: "COMMENT", commentCount: 0, stdout: "", stderr: "" };
      },
    } as unknown as Partial<ReviewGateway>);
    const config = {
      version: 1, admins: [], blocklist: [], audience: {}, escalation: {}, slack: {},
      mraWorkspace: path.join(tmp, "ws"),
      review: { enabled: true, expectedGhUser: "expected-bot", ghToken: "gho_pinned" },
    } as never;
    const c = new ReviewCoordinator({ web: web as never, config, onLog: () => {}, gateway });
    await c.fromMessage({
      channelId: "C1", threadTs: "1.1", userId: "U1",
      text: ":cr: https://github.com/onead/OnePixel/pull/12",
    });
    assert.equal(authOpts?.token, "gho_pinned", "actor-verify must use the pinned token");
    assert.equal(mraArgs?.ghToken, undefined, "MRA analysis subprocess must not receive the pinned token");
  });
});

describe("ReviewCoordinator provider strategy selection", () => {
  it("effectiveMraReviewStrategy preserves configured :cr: strategy only for Claude", () => {
    assert.equal(effectiveMraReviewStrategy("debate", "claude", false), "debate");
    assert.equal(effectiveMraReviewStrategy("personas", "claude", false), "personas");
    assert.equal(effectiveMraReviewStrategy("debate", "codex", false), "standard");
    assert.equal(effectiveMraReviewStrategy("personas", "fallback", false), "standard");
    assert.equal(effectiveMraReviewStrategy("debate", "dual", false), "standard");
    assert.equal(effectiveMraReviewStrategy("debate", "claude", true), "standard");
  });

  it(":cr: defaults to provider=codex and standard strategy for mra", async () => {
    const web = new FakeWebClient();
    let mraArgs: { strategy?: string; providerMode?: string } | undefined;
    const gateway = gw({
      runMraReview: async (a: { strategy?: string; providerMode?: string }) => {
        mraArgs = a;
        return { ok: true, status: "COMMENT", commentCount: 0, stdout: "", stderr: "" };
      },
    } as unknown as Partial<ReviewGateway>);
    await coord(web, gateway).fromMessage({
      channelId: "C1",
      threadTs: "1.1",
      userId: "U1",
      text: ":cr: https://github.com/onead/OnePixel/pull/12",
    });
    assert.equal(mraArgs?.providerMode, "codex");
    assert.equal(mraArgs?.strategy, "standard");
    assert.equal((mraArgs as Record<string, unknown>)?.expectedHeadSha, "headsha");
  });

  it(":cr: preserves debate when the admin-selected provider is claude", async () => {
    const web = new FakeWebClient();
    let mraArgs: { strategy?: string; providerMode?: string } | undefined;
    const gateway = gw({
      runMraReview: async (a: { strategy?: string; providerMode?: string }) => {
        mraArgs = a;
        return { ok: true, status: "COMMENT", commentCount: 0, stdout: "", stderr: "" };
      },
    } as unknown as Partial<ReviewGateway>);
    const config = {
      version: 1, admins: [], blocklist: [], audience: {}, escalation: {}, slack: {},
      mraWorkspace: path.join(tmp, "ws"),
      review: {
        enabled: true,
        expectedGhUser: "expected-bot",
        strategy: "debate",
        providerMode: "claude",
      },
    } as never;
    const c = new ReviewCoordinator({ web: web as never, config, onLog: () => {}, gateway, sleep: async () => {} });
    await c.fromMessage({
      channelId: "C1",
      threadTs: "1.1",
      userId: "U1",
      text: ":cr: https://github.com/onead/OnePixel/pull/12",
    });
    assert.equal(mraArgs?.providerMode, "claude");
    assert.equal(mraArgs?.strategy, "debate");
  });
});

describe("ReviewCoordinator live review config reload", () => {
  it("revokes approve access immediately when an admin is removed from live config", async () => {
    const web = new FakeWebClient();
    let reviewed = false;
    const startupConfig = {
      version: 1, admins: ["U1"], blocklist: [], audience: {}, escalation: {}, slack: {},
      mraWorkspace: path.join(tmp, "ws"), review: { enabled: true, approval: { enabled: true } },
    } as never;
    saveGatewayConfig({
      version: 1, admins: [], blocklist: [], audience: {} as never, escalation: {} as never,
      slack: {}, mraWorkspace: path.join(tmp, "ws"), review: { enabled: true, approval: { enabled: true } },
    });
    const c = new ReviewCoordinator({ web: web as never, config: startupConfig, onLog: () => {}, gateway: gw({
      runMraReview: async () => { reviewed = true; return { ok: true, status: "APPROVED", stdout: "", stderr: "" }; },
    } as unknown as Partial<ReviewGateway>) });
    await c.fromApproveMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: ":a: https://github.com/onead/OnePixel/pull/12" });
    assert.equal(reviewed, false);
    assert.ok(web.posted.some((p) => /只能由 PMK admin/.test(p.text ?? "")));
  });

  it("reloads raw review config without resolving unrelated Slack secret commands", async () => {
    const web = new FakeWebClient();
    const logs: string[] = [];
    let mraArgs: { strategy?: string; providerMode?: string } | undefined;
    const gateway = gw({
      runMraReview: async (a: { strategy?: string; providerMode?: string }) => {
        mraArgs = a;
        return { ok: true, status: "COMMENT", commentCount: 0, stdout: "", stderr: "" };
      },
    } as unknown as Partial<ReviewGateway>);
    const startupConfig = {
      version: 1, admins: [], blocklist: [], audience: {}, escalation: {}, slack: {},
      mraWorkspace: path.join(tmp, "ws-startup"),
      review: {
        enabled: true,
        expectedGhUser: "expected-bot",
        strategy: "debate",
        providerMode: "codex",
      },
    } as never;
    saveGatewayConfig({
      version: 1,
      admins: [],
      blocklist: [],
      audience: {} as never,
      escalation: {} as never,
      slack: {
        appToken: { cmd: `${process.execPath} -e "process.exit(9)"` },
        botToken: { cmd: `${process.execPath} -e "process.exit(9)"` },
      },
      mraWorkspace: path.join(tmp, "ws-live"),
      review: {
        enabled: true,
        expectedGhUser: "expected-bot",
        strategy: "debate",
        providerMode: "claude",
      },
    });
    const c = new ReviewCoordinator({
      web: web as never,
      config: startupConfig,
      onLog: (m) => logs.push(m),
      gateway,
      sleep: async () => {},
    });
    await c.fromMessage({
      channelId: "C1",
      threadTs: "1.1",
      userId: "U1",
      text: ":cr: https://github.com/onead/OnePixel/pull/12",
    });
    assert.equal(mraArgs?.providerMode, "claude");
    assert.equal(mraArgs?.strategy, "debate");
    assert.equal(logs.some((m) => m.includes("live config reload failed")), false);
  });

  it("treats the live review block as authoritative when fields are removed", async () => {
    const web = new FakeWebClient();
    let mraArgs: { allowApprove?: boolean; ghToken?: string } | undefined;
    const gateway = gw({
      runMraReview: async (a: { allowApprove?: boolean; ghToken?: string }) => {
        mraArgs = a;
        return { ok: true, status: "COMMENT", commentCount: 0, stdout: "", stderr: "" };
      },
    } as unknown as Partial<ReviewGateway>);
    const startupConfig = {
      version: 1, admins: [], blocklist: [], audience: {}, escalation: {}, slack: {},
      mraWorkspace: path.join(tmp, "ws"),
      review: {
        enabled: true,
        expectedGhUser: "expected-bot",
        allowApprove: true,
        ghToken: "gho_startup",
      },
    } as never;
    saveGatewayConfig({
      version: 1,
      admins: [],
      blocklist: [],
      audience: {} as never,
      escalation: {} as never,
      slack: {},
      mraWorkspace: path.join(tmp, "ws"),
      review: { enabled: true },
    });
    const c = new ReviewCoordinator({ web: web as never, config: startupConfig, onLog: () => {}, gateway, sleep: async () => {} });
    await c.fromMessage({
      channelId: "C1",
      threadTs: "1.1",
      userId: "U1",
      text: ":cr: https://github.com/onead/OnePixel/pull/12",
    });
    assert.equal(mraArgs?.allowApprove, undefined);
    assert.equal(mraArgs?.ghToken, undefined);
  });

  it("disables reviews live when the review block is removed", async () => {
    const web = new FakeWebClient();
    let reviewed = false;
    const gateway = gw({
      runMraReview: async () => {
        reviewed = true;
        return { ok: true, status: "COMMENT", commentCount: 0, stdout: "", stderr: "" };
      },
    } as unknown as Partial<ReviewGateway>);
    const startupConfig = {
      version: 1, admins: [], blocklist: [], audience: {}, escalation: {}, slack: {},
      mraWorkspace: path.join(tmp, "ws"),
      review: { enabled: true, expectedGhUser: "expected-bot" },
    } as never;
    saveGatewayConfig({
      version: 1,
      admins: [],
      blocklist: [],
      audience: {} as never,
      escalation: {} as never,
      slack: {},
      mraWorkspace: path.join(tmp, "ws"),
    });
    const c = new ReviewCoordinator({ web: web as never, config: startupConfig, onLog: () => {}, gateway, sleep: async () => {} });
    await c.fromMessage({
      channelId: "C1",
      threadTs: "1.1",
      userId: "U1",
      text: ":cr: https://github.com/onead/OnePixel/pull/12",
    });
    assert.equal(reviewed, false);
  });

  it("strict live reload disables reviews when gateway.json is missing", async () => {
    const web = new FakeWebClient();
    const logs: string[] = [];
    let reviewed = false;
    const gateway = gw({
      runMraReview: async () => {
        reviewed = true;
        return { ok: true, status: "COMMENT", commentCount: 0, stdout: "", stderr: "" };
      },
    } as unknown as Partial<ReviewGateway>);
    const startupConfig = {
      version: 1, admins: [], blocklist: [], audience: {}, escalation: {}, slack: {},
      mraWorkspace: path.join(tmp, "ws"),
      review: { enabled: true, expectedGhUser: "expected-bot" },
    } as never;
    const c = new ReviewCoordinator({
      web: web as never,
      config: startupConfig,
      onLog: (m) => logs.push(m),
      gateway,
      sleep: async () => {},
      strictLiveConfigReload: true,
    });
    await c.fromMessage({
      channelId: "C1",
      threadTs: "1.1",
      userId: "U1",
      text: ":cr: https://github.com/onead/OnePixel/pull/12",
    });
    assert.equal(reviewed, false);
    assert.equal(logs.some((m) => m.includes("live config missing")), true);
  });

  it("strict live reload disables reviews when gateway.json is corrupt", async () => {
    const web = new FakeWebClient();
    const logs: string[] = [];
    let reviewed = false;
    const gateway = gw({
      runMraReview: async () => {
        reviewed = true;
        return { ok: true, status: "COMMENT", commentCount: 0, stdout: "", stderr: "" };
      },
    } as unknown as Partial<ReviewGateway>);
    const startupConfig = {
      version: 1, admins: [], blocklist: [], audience: {}, escalation: {}, slack: {},
      mraWorkspace: path.join(tmp, "ws"),
      review: {
        enabled: true,
        expectedGhUser: "expected-bot",
        allowApprove: true,
        ghToken: "gho_startup",
      },
    } as never;
    const file = gatewayConfigPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json", "utf8");
    const c = new ReviewCoordinator({
      web: web as never,
      config: startupConfig,
      onLog: (m) => logs.push(m),
      gateway,
      sleep: async () => {},
      strictLiveConfigReload: true,
    });
    await c.fromMessage({
      channelId: "C1",
      threadTs: "1.1",
      userId: "U1",
      text: ":cr: https://github.com/onead/OnePixel/pull/12",
    });
    assert.equal(reviewed, false);
    assert.equal(logs.some((m) => m.includes("live config reload failed")), true);
  });
});

describe("ReviewCoordinator approve intent forwarding", () => {
  it("does not let :cr: submit GitHub approval", async () => {
    const web = new FakeWebClient();
    let mraArgs: { allowApprove?: boolean } | undefined;
    const gateway = gw({
      runMraReview: async (a: { allowApprove?: boolean }) => {
        mraArgs = a;
        return { ok: true, status: "COMMENT", commentCount: 0, stdout: "", stderr: "" };
      },
    } as unknown as Partial<ReviewGateway>);
    const config = {
      version: 1, admins: [], blocklist: [], audience: {}, escalation: {}, slack: {},
      mraWorkspace: path.join(tmp, "ws"),
      review: { enabled: true, expectedGhUser: "expected-bot" },
    } as never;
    const c = new ReviewCoordinator({ web: web as never, config, onLog: () => {}, gateway });
    await c.fromMessage({
      channelId: "C1", threadTs: "1.1", userId: "U1",
      text: ":cr: https://github.com/onead/OnePixel/pull/12",
    });
    assert.equal(mraArgs?.allowApprove, undefined, ":cr: analysis subprocess has no approval capability");
  });
});

describe("ReviewCoordinator immediate ack (detached UX)", () => {
  it("single PR: NO standalone 收到 ack — the progress bar is the ack — but it still precedes mra", async () => {
    const web = new FakeWebClient();
    let progressBeforeReview = false;
    const gateway = gw({
      runMraReview: async () => {
        // by the time mra runs, the per-PR progress anchor is already on the thread
        progressBeforeReview = web.posted.some((p) => /準備工作區/.test(p.text ?? ""));
        return { ok: true, status: "COMMENT", commentCount: 0, stdout: "", stderr: "" };
      },
    } as unknown as Partial<ReviewGateway>);
    await coord(web, gateway).fromMessage({
      channelId: "C1", threadTs: "1.1", userId: "U1",
      text: ":cr: https://github.com/onead/OnePixel/pull/12",
    });
    assert.equal(progressBeforeReview, true, "the progress bar must precede the per-PR review work");
    assert.ok(
      !web.posted.some((p) => /收到.*背景 review/.test(p.text ?? "")),
      "a single PR must NOT get a separate 收到 ack (it would be dead clutter above the progress bar)",
    );
  });

  it("multiple PRs: posts ONE summary 收到 ack before the per-PR work", async () => {
    const web = new FakeWebClient();
    let ackedBeforeReview = false;
    const gateway = gw({
      runMraReview: async () => {
        ackedBeforeReview = web.posted.some((p) => /收到.*背景 review 2 個 PR/.test(p.text ?? ""));
        return { ok: true, status: "COMMENT", commentCount: 0, stdout: "", stderr: "" };
      },
    } as unknown as Partial<ReviewGateway>);
    await coord(web, gateway).fromMessage({
      channelId: "C1", threadTs: "1.1", userId: "U1",
      text: ":cr: https://github.com/onead/OnePixel/pull/12 https://github.com/onead/OnePixel/pull/13",
    });
    assert.equal(ackedBeforeReview, true, "the summary ack must precede the per-PR work for N>1 PRs");
  });

  it("single :a: approve: NO standalone :lock: ack (progress bar covers it)", async () => {
    const web = new FakeWebClient();
    await coord(web, gw({
      runMraReview: async () => ({ ok: true, status: "APPROVED", commentCount: 0, stdout: "", stderr: "" }),
    } as unknown as Partial<ReviewGateway>)).fromApproveMessage({
      channelId: "C1", threadTs: "1.1", userId: "U1",
      text: ":a: https://github.com/onead/OnePixel/pull/12",
    });
    assert.ok(
      !web.posted.some((p) => /先快速 review 再決定是否 approve/.test(p.text ?? "")),
      "a single :a: must not post the standalone 收到 ack",
    );
  });

  it("no ack when there are no PR refs (silent, no spurious post)", async () => {
    const web = new FakeWebClient();
    await coord(web, gw()).fromMessage({
      channelId: "C1", threadTs: "1.1", userId: "U1", text: ":cr: no link here",
    });
    assert.equal(web.posted.length, 0);
  });
});

describe("ReviewCoordinator idempotency UX (already-reviewed note)", () => {
  it("re-review of the SAME commit posts an 'already reviewed' note (not silent)", async () => {
    const web = new FakeWebClient();
    const c = coord(web, gw()); // gw().getPrHead returns a constant head sha
    const msg = {
      channelId: "C1", threadTs: "1.1", userId: "U1",
      text: ":cr: https://github.com/onead/OnePixel/pull/12",
    };
    await c.fromMessage(msg); // first review claims + posts a result
    const n = web.posted.length;
    await c.fromMessage({ ...msg, threadTs: "1.2" }); // same PR + head → already done
    const after = web.posted.slice(n);
    assert.ok(
      after.some((p) => /已經 review 過|完成 review/.test(p.text ?? "")),
      "second review of the same commit must post an 'already reviewed' note, not stay silent",
    );
  });

  it("the note reports the prior verdict + link, and offers an admin `rerun`", async () => {
    const web = new FakeWebClient();
    const c = coord(web, gw()); // default result: CHANGES_REQUESTED, 2 comments
    const msg = {
      channelId: "C1", threadTs: "1.1", userId: "U1", // U1 is an admin
      text: ":cr: https://github.com/onead/OnePixel/pull/12",
    };
    await c.fromMessage(msg);
    const n = web.posted.length;
    await c.fromMessage({ ...msg, threadTs: "1.2" });
    const after = web.posted.slice(n).map((p) => p.text ?? "").join("\n");
    assert.match(after, /CHANGES_REQUESTED/, "the skip note must carry what was decided last time");
    assert.match(after, /pull\/12/, "and where to read it");
    assert.match(after, /`rerun`/, "an admin must learn they can force a re-review");
  });

  it("`:a:` on an already-reviewed clean commit points at the waiting offer, not at pushing", async () => {
    const web = new FakeWebClient();
    const c = coord(web, gw({ runMraReview: async () => eligibleReviewResult() as never }));
    const thread = { channelId: "C1", threadTs: "1.1", userId: "U1" };
    // :cr: reviews the commit clean → an approve offer is saved on this thread.
    await c.fromMessage({ ...thread, text: ":cr: https://github.com/onead/OnePixel/pull/12" });
    const n = web.posted.length;
    // Same commit, now via :a: — the pre-review hits the finalized claim.
    await c.fromMessage({ ...thread, text: ":a: https://github.com/onead/OnePixel/pull/12" });
    const after = web.posted.slice(n).map((p) => p.text ?? "");
    assert.ok(
      after.some((t) => /回覆 `approve`/.test(t)),
      "the pending offer is the open next step and must be named",
    );
    assert.ok(
      !after.some((t) => /推新 commit|push 後再發/.test(t)),
      "must not send an approver off to push a commit that does not exist",
    );
  });
});

describe("ReviewCoordinator.drainOnShutdown (A graceful drain)", () => {
  it("aborts an in-flight review (SIGTERM its child) + releases its claim", async () => {
    const web = new FakeWebClient();
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    let abortedReason: string | undefined;
    const c = coord(
      web,
      gw({
        // Block until the gateway aborts — simulates an mra review mid-flight.
        runMraReview: ((args: { signal?: AbortSignal }) =>
          new Promise((resolve) => {
            started();
            args.signal?.addEventListener("abort", () => {
              abortedReason = "aborted (gateway shutdown)";
              resolve({ ok: false, reason: abortedReason, stdout: "", stderr: "" });
            });
          })) as never,
      }),
    );
    // detached — don't await; it parks inside runMraReview
    const p = c.fromMessage({
      channelId: "C1",
      threadTs: "1.1",
      userId: "U1",
      text: ":cr: <https://github.com/onead/OnePixel/pull/3|#3>",
    });
    await startedP; // review is now registered as in-flight

    const logs: string[] = [];
    const drained = c.drainOnShutdown((m) => logs.push(m));
    assert.equal(drained, 1, "the one in-flight review is drained");
    assert.equal(abortedReason, "aborted (gateway shutdown)", "its mra child was aborted");
    assert.ok(
      logs.some((l) => /interrupted .*#3 by shutdown/.test(l)),
      "drain logs the interrupted PR",
    );

    await p; // the aborted review settles + its finally runs
    // claim was released → the same commit can be claimed (re-reviewed) again
    const { claimReview } = await import("../src/gateway/review-claim");
    assert.equal(
      claimReview({ owner: "onead", repo: "OnePixel", pr: 3, headSha: "headsha" }),
      true,
      "drained review's claim must be released so the PR is re-reviewable",
    );
  });

  it("posts the interruption+retry notice to the in-flight review's thread", async () => {
    const web = new FakeWebClient();
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const c = coord(
      web,
      gw({
        runMraReview: ((args: { signal?: AbortSignal }) =>
          new Promise((resolve) => {
            started();
            args.signal?.addEventListener("abort", () =>
              resolve({ ok: false, reason: "aborted", stdout: "", stderr: "" }),
            );
          })) as never,
      }),
    );
    const p = c.fromMessage({
      channelId: "C-REV",
      threadTs: "9.9",
      userId: "U1",
      text: ":cr: <https://github.com/onead/OnePixel/pull/4|#4>",
    });
    await startedP; // review is registered as in-flight on C-REV / 9.9

    c.drainOnShutdown(() => {});
    // the notice is fire-and-forget (void this.reply(...)); flush microtasks
    await new Promise((res) => setImmediate(res));

    const notice = web.posted.find((m) =>
      /因服務重新啟動中斷|retry/.test(m.text ?? ""),
    );
    assert.ok(notice, "drain must post an interruption+retry notice");
    assert.equal(notice!.channel, "C-REV", "notice goes to the review's channel");
    assert.equal(notice!.thread_ts, "9.9", "notice is threaded under the review");

    await p; // settle the aborted review
  });

  it("drains nothing (returns 0) when no review is in flight", async () => {
    const c = coord(new FakeWebClient(), gw());
    assert.equal(c.drainOnShutdown(() => {}), 0);
  });
});

describe("isRetryRequest", () => {
  it("matches a bare retry / 重試 (trimmed, case-insensitive)", () => {
    for (const t of ["retry", "  Retry ", "RETRY", "重試"]) {
      assert.equal(isRetryRequest(t), true, `should match: '${t}'`);
    }
    assert.equal(isRetryRequest("重跑"), false, "重跑 is the explicit forced-rerun command");
    assert.equal(isRerunRequest("重跑"), true);
    assert.equal(isRerunRequest("rerun"), true);
  });
  it("does NOT match chat that merely contains 'retry'", () => {
    for (const t of ["please retry", "retry the build", "", ":cr: x"]) {
      assert.equal(isRetryRequest(t), false, `should not match: '${t}'`);
    }
  });
});

describe("isApproveConfirmationRequest", () => {
  it("matches explicit approve confirmations only", () => {
    for (const t of ["approve", "confirm approve", "確認 approve", "確認approve", "核准"]) {
      assert.equal(isApproveConfirmationRequest(t), true, `should match: '${t}'`);
    }
  });
  it("does NOT match ordinary chat that merely mentions approve", () => {
    for (const t of ["please approve after deploy", "approval status?", "", ":a: https://github.com/o/r/pull/1"]) {
      assert.equal(isApproveConfirmationRequest(t), false, `should not match: '${t}'`);
    }
  });
  // The bot asks the admin to "@PMK 回覆 approve" in a thread whose root is a
  // `:a:`/`:cr:` message carrying the PR link. Re-sending that link alongside
  // the confirmation is the natural reply, and used to fall through to
  // free-chat instead of authorizing.
  it("matches an approve confirmation that also carries a PR link", () => {
    for (const t of [
      "approve\nhttps://github.com/onead/super-dsp-2.0/pull/748",
      "approve https://github.com/o/r/pull/1",
      "確認 approve https://github.com/o/r/pull/1",
      "核准 https://github.com/o/r/pull/1",
    ]) {
      assert.equal(isApproveConfirmationRequest(t), true, `should match: '${t}'`);
    }
  });
  it("still does NOT match ordinary chat that mentions approve near a PR link", () => {
    for (const t of [
      "please approve after deploy https://github.com/o/r/pull/1",
      "https://github.com/o/r/pull/1 這個 PR 我已經 approve 了",
    ]) {
      assert.equal(isApproveConfirmationRequest(t), false, `should not match: '${t}'`);
    }
  });
});

describe("ReviewCoordinator.retryInThread", () => {
  it("re-runs the review for the thread root's :cr: message", async () => {
    const web = new FakeWebClient();
    // the thread root (fetched via conversations.history) is the original trigger
    web.conversationsHistoryResponse = {
      ok: true,
      messages: [{ text: ":cr: <https://github.com/onead/OnePixel/pull/7|#7>" }],
    };
    await coord(web, gw()).retryInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });
    assert.ok(
      web.posted.some((p) => /CHANGES_REQUESTED|#7/.test(p.text ?? "")),
      "retry should re-run the root PR review and post its result",
    );
  });

  it("nudges when the thread root is not a :cr: review request", async () => {
    const web = new FakeWebClient();
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: "just chatting" }] };
    await coord(web, gw()).retryInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });
    assert.ok(
      web.posted.some((p) => /沒有可重試|重新發起/.test(p.text ?? "")),
      "retry in a non-review thread must nudge, not silently no-op",
    );
  });

  // M5: a drained :a: approve posts "回 retry 即可重跑", but the old retry path
  // only recognised :cr: roots → replied "沒有可重試" and silently downgraded the
  // user's approve intent. Retry of an :a: thread must re-run the APPROVE flow.
  it("re-runs the APPROVE flow when the thread root is an :a: request (not the nudge)", async () => {
    const web = new FakeWebClient();
    web.conversationsHistoryResponse = {
      ok: true,
      messages: [{ text: ":a: <https://github.com/onead/OnePixel/pull/7|#7>" }],
    };
    let approveArgs: Record<string, unknown> | undefined;
    await coord(web, gw({
      runMraReview: async (a: Record<string, unknown>) => {
        approveArgs = a;
        return { ok: true, status: "APPROVED", commentCount: 0, stdout: "", stderr: "" };
      },
    } as unknown as Partial<ReviewGateway>)).retryInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });
    assert.equal(approveArgs?.["allowApprove"], undefined, "retry of an :a: thread re-runs analysis without approval flags");
    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(!allTexts.some((t) => /沒有可重試/.test(t)), "must NOT post the nudge for an :a: thread root");
  });
});

// roccochen retried `approve` 7 times over 2 hours against superdsp-ui and got
// the same unactionable "repository protection is not approval-ready" each
// time. The message must name what is missing and who can change it.
describe("protectionNotReadyMessage", () => {
  it("names the two missing ruleset controls when the repo IS gated", () => {
    const m = protectionNotReadyMessage("onead/superdsp-ui", "main", true);
    assert.ok(m.includes("onead/superdsp-ui"), "names the repo");
    assert.ok(/dismiss_stale_reviews_on_push/.test(m), "names the first control");
    assert.ok(/require_last_push_approval/.test(m), "names the second control");
    assert.ok(/admin/i.test(m), "says who can fix it");
  });

  it("says the protection could not be READ when the probe ran and came back unknown", () => {
    const m = protectionNotReadyMessage("onead/x", "main", undefined, true);
    assert.ok(/讀取|無法確認/.test(m), "distinguishes unreadable from underprotected");
    assert.ok(!/dismiss_stale_reviews_on_push/.test(m), "must not claim a specific missing control it never observed");
  });

  // Flag off → the probe never runs, but approvalProtectionReady already told
  // us the two controls are not both on. Explain that rather than guessing.
  it("names the missing controls when the probe was never consulted", () => {
    const m = protectionNotReadyMessage("onead/x", "main", undefined, false);
    assert.ok(/缺少兩項必要保護/.test(m));
    assert.ok(!/無法確認/.test(m), "an unprobed refusal must not claim the API was unreadable");
  });

  it("never tells the reader to edit host-side settings", () => {
    for (const [s, p] of [[true, true], [undefined, true], [undefined, false]] as const) {
      const m = protectionNotReadyMessage("o/r", "main", s, p);
      assert.ok(!/~\/\.claude|allowedTools|\/permissions/.test(m));
    }
  });
});

describe("ReviewCoordinator.confirmApproveInThread", () => {
  /** Live gateway.json that revokes approval — currentConfig() prefers the file. */
  function revokeApprovalOnDisk() {
    saveGatewayConfig({
      version: 1, admins: ["U1"], blocklist: [], audience: {}, escalation: {}, slack: {},
      mraWorkspace: path.join(tmp, "ws"),
      review: { enabled: true, approval: { enabled: false }, expectedGhUser: "expected-bot" },
    } as never);
  }

  it("keeps an eligible protocol artifact review-only when approval was config-revoked after the offer (#90)", async () => {
    const web = new FakeWebClient();
    const calls: Array<Record<string, unknown>> = [];
    const gateway = gw({
      runMraReview: async (a: Record<string, unknown>) => {
        calls.push(a);
        return eligibleReviewResult();
      },
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway);
    const rootText = ":cr: https://github.com/onead/OnePixel/pull/12";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    // Admin revokes approval BETWEEN the offer and the confirmation.
    revokeApprovalOnDisk();
    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });

    assert.equal(calls.length, 1, "confirmation must reuse the SHA-bound artifact");
    assert.equal(calls[0]?.["allowApprove"], undefined, ":cr: remains analysis-only");
    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(allTexts.some((t) => /回覆 `approve`|授權 GitHub approve/.test(t)), ":cr: result should ask for explicit authorization");
    assert.ok(allTexts.some((t) => /安全停用|不會執行 approve/.test(t)), "config-revoked approval must block the GitHub mutation");
    assert.ok(!allTexts.some((t) => /已真實 approve/.test(t)));
  });

  it("does not consume the review artifact while approval is config-revoked", async () => {
    const web = new FakeWebClient();
    let calls = 0;
    const gateway = gw({
      runMraReview: async () => {
        calls++;
        return eligibleReviewResult();
      },
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway);
    const rootText = ":cr: https://github.com/onead/OnePixel/pull/12";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };
    revokeApprovalOnDisk();
    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });
    assert.equal(calls, 1, "first confirmation reuses the earlier artifact");

    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });
    assert.equal(calls, 1, "second confirmation for the same artifact is idempotent");
    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(allTexts.filter((t) => /安全停用|不會執行 approve/.test(t)).length >= 2, "each confirmation must report the revoked policy");
  });

  // A confirmation may carry a PR link, but the THREAD's offer selects the PR.
  // A link naming a different PR is an intent mismatch: the admin believes they
  // are approving what they pasted. Refuse loudly and leave the offer unused.
  it("refuses a confirmation whose PR link names a different PR than the thread's", async () => {
    const web = new FakeWebClient();
    let calls = 0;
    const gateway = gw({
      runMraReview: async () => {
        calls++;
        return eligibleReviewResult();
      },
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway);
    const rootText = ":cr: https://github.com/onead/OnePixel/pull/12";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    await c.confirmApproveInThread({
      channelId: "C1", threadTs: "1.1", userId: "U1",
      text: "approve https://github.com/onead/OnePixel/pull/999",
    });

    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(allTexts.some((t) => /不同的 PR|#999/.test(t)), "must name the mismatch");
    assert.ok(!allTexts.some((t) => /已真實 approve/.test(t)), "must not approve anything");
    assert.equal(calls, 1, "must not run another review");

    // The offer survives: confirming again without a link still works.
    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });
    const after = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(!after.some((t) => /沒有有效、未使用的 approve offer/.test(t)), "mismatch must not consume the offer");
  });

  it("accepts a confirmation whose PR link matches the thread's PR", async () => {
    const web = new FakeWebClient();
    const gateway = gw({
      runMraReview: async () => eligibleReviewResult(),
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway);
    const rootText = ":cr: https://github.com/onead/OnePixel/pull/12";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    await c.confirmApproveInThread({
      channelId: "C1", threadTs: "1.1", userId: "U1",
      text: "approve\nhttps://github.com/onead/OnePixel/pull/12",
    });

    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(!allTexts.some((t) => /不同的 PR/.test(t)), "matching link must not be treated as a mismatch");
    assert.ok(!allTexts.some((t) => /沒有有效、未使用的 approve offer/.test(t)), "matching link must reach the offer");
  });

  it("publishes a real approval end-to-end when policy allows (#90 veto lifted)", async () => {
    const web = new FakeWebClient();
    let approved = 0;
    const gateway = gw({
      runMraReview: async () => eligibleReviewResult(),
      createPullRequestApproval: async (a: { commitId: string }) => {
        approved++;
        return { reviewId: 99, state: "APPROVED", commitId: a.commitId, actor: "expected-bot" };
      },
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway);
    const rootText = ":cr: https://github.com/onead/OnePixel/pull/12";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });

    assert.equal(approved, 1, "the gated confirmation must publish exactly one GitHub approval");
    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(allTexts.some((t) => /已真實 approve/.test(t)));

    // The consumed offer must not be publishable twice.
    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });
    assert.equal(approved, 1, "a consumed offer must never approve again");
  });

  it("approves when only the PR's updatedAt moved (our own review post bumps it) — sha+base still pin (#90 live-verify bug)", async () => {
    const web = new FakeWebClient();
    let approved = 0;
    let updatedAt = "2026-07-17T01:00:00Z";
    const gateway = gw({
      listPrDiscussion: async () => [],
      getPrHead: async () => ({ sha: "headsha", baseRef: "main", updatedAt }),
      runMraReview: async () => eligibleReviewResult(),
      createPullRequestApproval: async (a: { commitId: string }) => {
        approved++;
        return { reviewId: 99, state: "APPROVED", commitId: a.commitId, actor: "expected-bot" };
      },
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway);
    const rootText = ":cr: https://github.com/onead/OnePixel/pull/12";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    // Posting the review (or any teammate comment) bumps the PR's updatedAt.
    // The code (sha) and target (baseRef) are unchanged — approve must proceed.
    updatedAt = "2026-07-17T01:05:00Z";
    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });

    assert.equal(approved, 1, "an updatedAt-only change must not invalidate the offer");
    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(allTexts.some((t) => /已真實 approve/.test(t)));
    assert.ok(!allTexts.some((t) => /changed after review/.test(t)));
  });

  it("a config write during the approve critical section is refused, never interleaved (#90)", async () => {
    const web = new FakeWebClient();
    let approved = 0;
    let writeError: Error | undefined;
    const gateway = gw({
      runMraReview: async () => eligibleReviewResult(),
      // Slow preflight keeps the authorization lock held long enough for the
      // concurrent write attempt below to land INSIDE the critical section.
      listPrDiscussion: async () => [],
      getPrHead: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return { sha: "headsha", baseRef: "main" };
      },
      createPullRequestApproval: async (a: { commitId: string }) => {
        approved++;
        return { reviewId: 99, state: "APPROVED", commitId: a.commitId, actor: "expected-bot" };
      },
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway);
    const rootText = ":cr: https://github.com/onead/OnePixel/pull/12";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    const confirming = c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });
    await new Promise((r) => setTimeout(r, 60)); // land inside the held section
    try {
      saveGatewayConfig({
        version: 1, admins: ["U1"], blocklist: [], audience: {}, escalation: {}, slack: {},
        mraWorkspace: path.join(tmp, "ws"),
        review: { enabled: true, approval: { enabled: false }, expectedGhUser: "expected-bot" },
      } as never);
    } catch (err) {
      writeError = err as Error;
    }
    await confirming;

    assert.ok(writeError, "the write inside the critical section must be refused");
    assert.equal(writeError?.name, "AuthorizationLockBusyError");
    assert.equal(approved, 1, "the in-flight approve completes under the policy valid at its start");
  });

  it("approves an exempt repo whose branch protection is not ready", async () => {
    const web = new FakeWebClient();
    let approved = 0;
    const gateway = gw({
      approvalProtectionReady: async () => false,
      resolveRepoSlug: async () => "onead/oss-ui-v2",
      runMraReview: async () => eligibleReviewResult(),
      createPullRequestApproval: async (a: { commitId: string }) => {
        approved++;
        return { reviewId: 99, state: "APPROVED", commitId: a.commitId, actor: "expected-bot" };
      },
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway, () => {}, {
      approval: {
        enabled: true,
        protectionExemptions: [{ repo: "onead/oss-ui-v2", reason: "ruleset 8015695 pending" }],
      },
    });
    const rootText = ":cr: https://github.com/onead/oss-ui-v2/pull/301";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });

    assert.equal(approved, 1, "an exempt repo must approve despite an unready probe");
    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(allTexts.some((t) => /已真實 approve/.test(t)));
    assert.ok(
      allTexts.some((t) => /不會讓這個 approval 失效/.test(t)),
      "the accepted risk must be disclosed at the moment it goes live",
    );
    assert.ok(allTexts.some((t) => /ruleset 8015695 pending/.test(t)), "the reason must be surfaced");
  });

  it("still refuses a non-exempt repo whose branch protection is not ready", async () => {
    const web = new FakeWebClient();
    let approved = 0;
    const gateway = gw({
      approvalProtectionReady: async () => false,
      runMraReview: async () => eligibleReviewResult(),
      createPullRequestApproval: async () => { approved++; throw new Error("must not be called"); },
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway, () => {}, {
      approval: {
        enabled: true,
        protectionExemptions: [{ repo: "onead/some-other-repo", reason: "unrelated" }],
      },
    });
    const rootText = ":cr: https://github.com/onead/OnePixel/pull/12";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });

    assert.equal(approved, 0, "an exemption for another repo must never leak across repos");
    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(allTexts.some((t) => /缺少兩項必要保護/.test(t)), "underprotected repo must name the two missing controls");
  });

  it("reports an exempt repo's waiver as obsolete once its branch is genuinely protected", async () => {
    const web = new FakeWebClient();
    let approved = 0;
    const gateway = gw({
      approvalProtectionReady: async () => true, // onead fixed the ruleset
      resolveRepoSlug: async () => "onead/oss-ui-v2",
      runMraReview: async () => eligibleReviewResult(),
      createPullRequestApproval: async (a: { commitId: string }) => {
        approved++;
        return { reviewId: 99, state: "APPROVED", commitId: a.commitId, actor: "expected-bot" };
      },
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway, () => {}, {
      approval: {
        enabled: true,
        protectionExemptions: [{ repo: "onead/oss-ui-v2", reason: "ruleset 8015695 pending" }],
      },
    });
    const rootText = ":cr: https://github.com/onead/oss-ui-v2/pull/301";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });

    assert.equal(approved, 1);
    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(allTexts.some((t) => /豁免已不再需要/.test(t)), "an obsolete waiver must announce itself");
    assert.ok(
      !allTexts.some((t) => /不會讓這個 approval 失效/.test(t)),
      "a protected branch must never carry the unprotected warning",
    );
  });

  it("refuses a protectionExemptions write that lands inside the approve critical section", async () => {
    const web = new FakeWebClient();
    let approved = 0;
    let writeError: Error | undefined;
    const gateway = gw({
      approvalProtectionReady: async () => true,
      runMraReview: async () => eligibleReviewResult(),
      // Slow preflight holds the authorization lock long enough for the
      // concurrent write below to land inside the critical section.
      listPrDiscussion: async () => [],
      getPrHead: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return { sha: "headsha", baseRef: "main" };
      },
      createPullRequestApproval: async (a: { commitId: string }) => {
        approved++;
        return { reviewId: 99, state: "APPROVED", commitId: a.commitId, actor: "expected-bot" };
      },
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway);
    const rootText = ":cr: https://github.com/onead/OnePixel/pull/12";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    const confirming = c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });
    await new Promise((r) => setTimeout(r, 60)); // land inside the held section
    try {
      saveGatewayConfig({
        version: 1, admins: ["U1"], blocklist: [], audience: {}, escalation: {}, slack: {},
        mraWorkspace: path.join(tmp, "ws"),
        review: {
          enabled: true, expectedGhUser: "expected-bot",
          approval: {
            enabled: true,
            protectionExemptions: [{ repo: "onead/OnePixel", reason: "injected mid-approve" }],
          },
        },
      } as never);
    } catch (err) {
      writeError = err as Error;
    }
    await confirming;

    assert.ok(writeError, "an exemption must not be injectable mid-approve");
    assert.equal(writeError?.name, "AuthorizationLockBusyError");
    assert.equal(approved, 1, "the in-flight approve completes under the policy valid at its start");
  });

  it("records every real approval in the audit log, flagging the accepted risk", async () => {
    const { readGatewayEvents } = await import("../src/gateway/events");
    const web = new FakeWebClient();
    const gateway = gw({
      approvalProtectionReady: async () => false,
      resolveRepoSlug: async () => "onead/oss-ui-v2",
      runMraReview: async () => eligibleReviewResult(),
      createPullRequestApproval: async (a: { commitId: string }) =>
        ({ reviewId: 4242, state: "APPROVED", commitId: a.commitId, actor: "expected-bot" }),
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway, () => {}, {
      approval: {
        enabled: true,
        protectionExemptions: [{ repo: "onead/oss-ui-v2", reason: "ruleset 8015695 pending" }],
      },
    });
    const rootText = ":cr: https://github.com/onead/oss-ui-v2/pull/301";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });

    const approvals = readGatewayEvents().filter((e) => e.type === "review.approved");
    assert.equal(approvals.length, 1, "a real GitHub approval must never be unaudited");
    const ev = approvals[0] as never as { actor: string; repo: string; pr: number; reviewId: number; approvalBasis: string };
    assert.equal(ev.actor, "U1");
    assert.equal(ev.repo, "onead/oss-ui-v2");
    assert.equal(ev.pr, 301);
    assert.equal(ev.reviewId, 4242);
    assert.equal(ev.approvalBasis, "exempt", "the accepted risk must be on the record");
  });

  it("approves an ungated repo when the flag is on, with basis 'ungated' and the no-gate note", async () => {
    const web = new FakeWebClient();
    let approved = 0;
    const gateway = gw({
      approvalProtectionReady: async () => false,
      reviewGateStatus: async () => false, // positively ungated
      resolveRepoSlug: async () => "onead/some-ungated-repo",
      runMraReview: async () => eligibleReviewResult(),
      createPullRequestApproval: async (a: { commitId: string }) => {
        approved++;
        return { reviewId: 555, state: "APPROVED", commitId: a.commitId, actor: "expected-bot" };
      },
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway, () => {}, { approval: { enabled: true, allowWhenNoReviewGate: true } });
    const rootText = ":cr: https://github.com/onead/some-ungated-repo/pull/7";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });

    assert.equal(approved, 1, "an ungated repo must approve when the flag is on");
    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(allTexts.some((t) => /已真實 approve/.test(t)));
    assert.ok(allTexts.some((t) => /未要求任何核准/.test(t)), "the no-gate note must be shown");
    assert.ok(!allTexts.some((t) => /不會讓這個 approval 失效/.test(t)), "an ungated repo must NOT carry the stale-approval warning");
  });

  it("refuses an ungated-candidate when the gate probe is unreadable (fail closed)", async () => {
    const web = new FakeWebClient();
    let approved = 0;
    const gateway = gw({
      approvalProtectionReady: async () => false,
      reviewGateStatus: async () => undefined, // unreadable → must fail closed
      runMraReview: async () => eligibleReviewResult(),
      createPullRequestApproval: async () => { approved++; throw new Error("must not be called"); },
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway, () => {}, { approval: { enabled: true, allowWhenNoReviewGate: true } });
    const rootText = ":cr: https://github.com/onead/OnePixel/pull/12";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });

    assert.equal(approved, 0, "an unreadable gate must never auto-allow");
    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(allTexts.some((t) => /無法確認.*保護狀態/.test(t)), "unreadable probe must not claim a specific missing control");
  });

  it("still refuses a gated repo with the flag on (the ungated path must not fire)", async () => {
    const web = new FakeWebClient();
    let approved = 0;
    const gateway = gw({
      approvalProtectionReady: async () => false,
      reviewGateStatus: async () => true, // gated
      runMraReview: async () => eligibleReviewResult(),
      createPullRequestApproval: async () => { approved++; throw new Error("must not be called"); },
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway, () => {}, { approval: { enabled: true, allowWhenNoReviewGate: true } });
    const rootText = ":cr: https://github.com/onead/OnePixel/pull/12";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });

    assert.equal(approved, 0, "a gated repo without an exemption must still be refused");
  });

  it("does not consult the gate probe when the flag is off (v0.33.0 parity)", async () => {
    const web = new FakeWebClient();
    let probed = 0, approved = 0;
    const gateway = gw({
      approvalProtectionReady: async () => false,
      reviewGateStatus: async () => { probed++; return false; },
      runMraReview: async () => eligibleReviewResult(),
      createPullRequestApproval: async () => { approved++; return { reviewId: 1, state: "APPROVED", commitId: "x", actor: "expected-bot" }; },
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway, () => {}, { approval: { enabled: true } }); // flag defaults off
    const rootText = ":cr: https://github.com/onead/OnePixel/pull/12";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });

    assert.equal(probed, 0, "the gate probe must not run when the flag is off");
    assert.equal(approved, 0, "an ungated repo with the flag off is refused, as in v0.33.0");
  });

  it("records approvalBasis 'ungated' in the audit log", async () => {
    const { readGatewayEvents } = await import("../src/gateway/events");
    const web = new FakeWebClient();
    const gateway = gw({
      approvalProtectionReady: async () => false,
      reviewGateStatus: async () => false,
      resolveRepoSlug: async () => "onead/some-ungated-repo",
      runMraReview: async () => eligibleReviewResult(),
      createPullRequestApproval: async (a: { commitId: string }) => ({ reviewId: 9, state: "APPROVED", commitId: a.commitId, actor: "expected-bot" }),
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway, () => {}, { approval: { enabled: true, allowWhenNoReviewGate: true } });
    const rootText = ":cr: https://github.com/onead/some-ungated-repo/pull/7";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: rootText });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };

    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });

    const ev = readGatewayEvents().filter((e) => e.type === "review.approved")[0] as never as { approvalBasis: string; exemptionReason?: string };
    assert.equal(ev.approvalBasis, "ungated");
    assert.equal(ev.exemptionReason, undefined);
  });

  it("names the review blocker when approve is replied but the review found blockers (no offer)", async () => {
    const { appendGatewayEvent } = await import("../src/gateway/events");
    const web = new FakeWebClient();
    const c = coord(web, gw());
    const rootText = ":cr: https://github.com/onead/super-dsp-2.0/pull/611";
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };
    // A blocked review was posted for this PR — so no approve offer was ever created.
    appendGatewayEvent({
      type: "review.posted", actor: "U1", repo: "onead/super-dsp-2.0", pr: 611,
      status: "CHANGES_REQUESTED", commentCount: 1, blockerCount: 1, durationMs: 1,
    });

    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });

    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(allTexts.some((t) => /發現.*1.*blocker/.test(t)), "must name the blocker count as the real reason");
    assert.ok(!allTexts.some((t) => /請先完成 `:cr:/.test(t)), "must not tell the admin to run a review they already ran");
  });

  it("keeps the generic no-offer message when no review has run for the thread's PR", async () => {
    const web = new FakeWebClient();
    const c = coord(web, gw());
    const rootText = ":cr: https://github.com/onead/OnePixel/pull/99";
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };
    // No review.posted event for #99 — genuinely no review ran.
    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });

    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(allTexts.some((t) => /請先完成 `:cr:/.test(t)), "generic guidance when there was genuinely no review");
  });

  it("keeps the generic no-offer message when the PR's most recent review was clean (offer consumed/expired)", async () => {
    const { appendGatewayEvent } = await import("../src/gateway/events");
    const web = new FakeWebClient();
    const c = coord(web, gw());
    const rootText = ":cr: https://github.com/onead/OnePixel/pull/42";
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: rootText }] };
    // The most recent review was clean (0 blockers) — a consumed/expired offer,
    // NOT a blocked review. Must not claim a blocker.
    appendGatewayEvent({
      type: "review.posted", actor: "U1", repo: "onead/OnePixel", pr: 42,
      status: "COMMENT", commentCount: 0, blockerCount: 0, durationMs: 1,
    });

    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });

    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(allTexts.some((t) => /請先完成 `:cr:/.test(t)), "a clean prior review must not be reported as a blocker");
    assert.ok(!allTexts.some((t) => /blocker/.test(t)));
  });
});

describe("ReviewCoordinator.fromApproveMessage (:a: approve flow)", () => {
  it("rejects a non-admin before running mra", async () => {
    const web = new FakeWebClient();
    let called = false;
    const config = {
      version: 1, admins: [], blocklist: [], audience: {}, escalation: {}, slack: {},
      mraWorkspace: path.join(tmp, "ws"), review: { enabled: true, approval: { enabled: true } },
    } as never;
    const c = new ReviewCoordinator({ web: web as never, config, onLog: () => {}, gateway: gw({
      runMraReview: async () => { called = true; return { ok: true, status: "APPROVED", stdout: "", stderr: "" }; },
    } as unknown as Partial<ReviewGateway>) });
    await c.fromApproveMessage({ channelId: "C1", threadTs: "1.1", userId: "U2", text: ":a: https://github.com/onead/OnePixel/pull/12" });
    assert.equal(called, false);
    assert.ok(web.posted.some((p) => /只能由 PMK admin/.test(p.text ?? "")));
  });

  it(":a: runs analysis first and never passes approval authority to MRA", async () => {
    const web = new FakeWebClient();
    let capturedArgs: Record<string, unknown> | undefined;
    const gateway = gw({
      runMraReview: async (a: Record<string, unknown>) => {
        capturedArgs = a;
        return eligibleReviewResult();
      },
    } as unknown as Partial<ReviewGateway>);
    await coord(web, gateway).fromApproveMessage({
      channelId: "C1",
      threadTs: "1.1",
      userId: "U1",
      text: ":a: https://github.com/onead/OnePixel/pull/12",
    });
    assert.equal(capturedArgs?.["strategy"], "standard", "strategy must be 'standard'");
    assert.equal(capturedArgs?.["allowApprove"], undefined);
    assert.equal(capturedArgs?.["approveIfNoHigh"], undefined);
    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(allTexts.some((t) => /回覆 `approve`/.test(t)), "eligible analysis must ask for explicit confirmation");
    assert.ok(!allTexts.some((t) => /真實 approve/.test(t)), ":a: alone must not approve");
  });

  it("CHANGES_REQUESTED path reports review blockers without approval", async () => {
    const web = new FakeWebClient();
    const gateway = gw({
      runMraReview: async () => ({
        ok: true, status: "CHANGES_REQUESTED", commentCount: 2, stdout: "", stderr: "",
      }),
    } as unknown as Partial<ReviewGateway>);
    await coord(web, gateway).fromApproveMessage({
      channelId: "C1",
      threadTs: "1.1",
      userId: "U1",
      text: ":a: https://github.com/onead/OnePixel/pull/12",
    });
    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(allTexts.some((t) => /CHANGES_REQUESTED|未執行 GitHub approve/.test(t)));
  });

  // M1: on mra's batch-fallback path there is no `status:` line → status is
  // undefined. The old code computed approved=false and claimed "未 approve —
  // 發現重大問題", which is a false statement on both axes (GitHub may actually
  // have approved). The honest result points the user to GitHub instead.
  it("undefined legacy status never claims approval", async () => {
    const web = new FakeWebClient();
    const gateway = gw({
      runMraReview: async () => ({
        ok: true, status: undefined, commentCount: 0, stdout: "", stderr: "",
      }),
    } as unknown as Partial<ReviewGateway>);
    await coord(web, gateway).fromApproveMessage({
      channelId: "C1",
      threadTs: "1.1",
      userId: "U1",
      text: ":a: https://github.com/onead/OnePixel/pull/12",
    });
    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(
      allTexts.some((t) => /未執行 GitHub approve/.test(t)),
      "undefined legacy status must remain review-only",
    );
    assert.ok(
      !allTexts.some((t) => /發現重大問題/.test(t)),
      "must NOT claim 發現重大問題 when the approve verdict is unknown",
    );
  });
});

describe("ReviewCoordinator exact-head approval offer", () => {
  it("exact-head preflight rejects a stale offer without any GitHub mutation (#90 veto lifted)", async () => {
    const web = new FakeWebClient();
    let head = "head-1";
    let calls = 0;
    let approved = 0;
    const c = coord(web, gw({
      listPrDiscussion: async () => [],
      getPrHead: async () => ({ sha: head, baseRef: "main" }),
      runMraReview: async () => { calls++; return eligibleReviewResult(head); },
      createPullRequestApproval: async () => { approved++; return { reviewId: 99, state: "APPROVED", commitId: head, actor: "expected-bot" }; },
    } as unknown as Partial<ReviewGateway>));
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: ":cr: https://github.com/onead/OnePixel/pull/12" });
    head = "head-2"; // PR moved after the review — the offer is now stale
    await c.confirmApproveInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });
    assert.equal(calls, 1, "changed head must not reach the approval model pass");
    assert.equal(approved, 0, "a stale offer must never produce a GitHub approval");
    assert.ok(web.posted.some((p) => /preflight 未通過|changed after review/.test(p.text ?? "")), "the rejection must be reported honestly");
  });
});

describe("ReviewCoordinator forced rerun", () => {
  it("lets an admin rerun a finalized same-SHA review", async () => {
    const web = new FakeWebClient();
    let calls = 0;
    const c = coord(web, gw({ runMraReview: async () => { calls++; return { ok: true, status: "COMMENT", commentCount: 0, stdout: "", stderr: "" }; } } as unknown as Partial<ReviewGateway>));
    const root = ":cr: https://github.com/onead/OnePixel/pull/12";
    await c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: root });
    web.conversationsHistoryResponse = { ok: true, messages: [{ text: root }] };
    await c.rerunInThread({ channelId: "C1", threadTs: "1.1", userId: "U1" });
    assert.equal(calls, 2);
  });
});

describe("ReviewCoordinator project concurrency", () => {
  it("does not run two reviews against the same shared project checkout", async () => {
    const web = new FakeWebClient();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const c = coord(web, gw({
      listPrDiscussion: async () => [],
      getPrHead: async ({ pr }: { pr: number }) => ({ sha: `head-${pr}`, baseRef: "main" }),
      runMraReview: async () => { calls++; await gate; return { ok: true, status: "COMMENT", commentCount: 0, stdout: "", stderr: "" }; },
    } as unknown as Partial<ReviewGateway>), () => {}, { maxConcurrent: 2, maxConcurrentPerUser: 2 });
    const first = c.fromMessage({ channelId: "C1", threadTs: "1.1", userId: "U1", text: ":cr: https://github.com/onead/OnePixel/pull/12" });
    await new Promise((resolve) => setImmediate(resolve));
    await c.fromMessage({ channelId: "C1", threadTs: "1.2", userId: "U1", text: ":cr: https://github.com/onead/OnePixel/pull/13" });
    assert.equal(calls, 1);
    // Asserts the CAUSE, not just that something was refused. The previous
    // assertion allowed either wording because the message itself named all
    // three limits joined by "或" — a user blocked by their own still-running
    // review of this repo was told the system was busy. admissionRefusal now
    // reports which limit fired, so the reply names the repo.
    assert.ok(
      web.posted.some((p) => /onead\/OnePixel/.test(p.text ?? "") && /同一個 repo/.test(p.text ?? "")),
      `expected a same-repo refusal naming the repo, got: ${JSON.stringify(web.posted.map((p) => p.text))}`,
    );
    release();
    await first;
  });
});

describe("ReviewCoordinator REVIEW_INCOMPLETE handling", () => {
  it(":a: retries once when the first review is REVIEW_INCOMPLETE, then posts the recovered outcome", async () => {
    const web = new FakeWebClient();
    let calls = 0;
    const gateway = gw({
      runMraReview: async () => {
        calls++;
        return calls === 1
          ? { ok: true, status: "COMMENT", commentCount: 0, incomplete: true, stdout: "posting REVIEW_INCOMPLETE", stderr: "" }
          : { ok: true, status: "APPROVED", commentCount: 0, incomplete: false, stdout: "", stderr: "" };
      },
    } as unknown as Partial<ReviewGateway>);
    await coord(web, gateway).fromApproveMessage({
      channelId: "C1", threadTs: "1.1", userId: "U1",
      text: ":a: https://github.com/onead/OnePixel/pull/12",
    });
    assert.equal(calls, 2, "an incomplete first review must trigger exactly one retry");
    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(allTexts.some((t) => /已完成.*review|未執行 GitHub approve/.test(t)), "the recovered review outcome must be delivered without approval");
  });

  it(":a: still REVIEW_INCOMPLETE after the retry → honest '未完成' message, and the claim is released so a same-commit :a: re-runs", async () => {
    const web = new FakeWebClient();
    let calls = 0;
    const gateway = gw({
      runMraReview: async () => {
        calls++;
        return { ok: true, status: "COMMENT", commentCount: 0, incomplete: true, stdout: "posting REVIEW_INCOMPLETE", stderr: "" };
      },
    } as unknown as Partial<ReviewGateway>);
    const c = coord(web, gateway);
    await c.fromApproveMessage({
      channelId: "C1", threadTs: "1.1", userId: "U1",
      text: ":a: https://github.com/onead/OnePixel/pull/12",
    });
    assert.equal(calls, 2, "one retry, then give up");
    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(allTexts.some((t) => /未完成|REVIEW_INCOMPLETE/.test(t)), "must honestly report the review did not complete");
    assert.ok(!allTexts.some((t) => /確認是否已 approve/.test(t)), "must NOT emit the misleading ambiguous approve message");
    // The incomplete review released (did NOT finalize) the per-commit claim, so a
    // second :a: on the SAME commit re-runs mra rather than being rejected as
    // "already reviewed" — otherwise the "請重試" advice is a dead end.
    calls = 0;
    await c.fromApproveMessage({
      channelId: "C1", threadTs: "1.2", userId: "U1",
      text: ":a: https://github.com/onead/OnePixel/pull/12",
    });
    assert.ok(calls >= 1, "same-commit retry must actually re-run mra (claim released, not finalized)");
  });
});

describe("review/approve result text (pure)", () => {
  const ref = { owner: "onead", repo: "OnePixel", number: 12, url: "https://x/pull/12" } as never;
  it("reviewResultText reports COMMENT without claiming GitHub approval", () => {
    const t = reviewResultText("onead/OnePixel", ref, { ...eligibleReviewResult(), commentCount: 3 } as never);
    assert.match(t, /GitHub action: COMMENT/);
    assert.match(t, /回覆 `approve`|授權 GitHub approve/);
    assert.doesNotMatch(t, /已 approve/);
  });
  it("canConfirmApproveFromReview only offers confirmation for complete COMMENT review results", () => {
    assert.equal(canConfirmApproveFromReview(eligibleReviewResult()), true);
    assert.equal(canConfirmApproveFromReview({ status: "COMMENT", commentCount: 0 }), false);
    assert.equal(canConfirmApproveFromReview({ status: "CHANGES_REQUESTED", commentCount: 1 }), false);
    assert.equal(canConfirmApproveFromReview({ status: "COMMENT", incomplete: true }), false);
  });
  it("approveResultText: APPROVED → 已 approve", () => {
    assert.match(approveResultText("onead/OnePixel", ref, { status: "APPROVED", commentCount: 1 } as never), /已 approve/);
  });
  it("approveResultText: CHANGES_REQUESTED → 未 approve / 已請求修改", () => {
    assert.match(approveResultText("onead/OnePixel", ref, { status: "CHANGES_REQUESTED", commentCount: 2 } as never), /未 approve.*已請求修改/);
  });
  it("approveResultText: undefined status → informational, no false '發現重大問題'", () => {
    const t = approveResultText("onead/OnePixel", ref, { status: undefined, commentCount: 0 } as never);
    assert.doesNotMatch(t, /發現重大問題/);
    assert.match(t, /確認是否已 approve|未回報 approve/);
  });
  it("approveResultText: REVIEW_INCOMPLETE → honest 未完成/未 approve/重試, NOT the ambiguous '確認是否已 approve'", () => {
    // status reads COMMENT on the incomplete path — without the incomplete flag this
    // would fall through to the misleading "請至 PR 確認是否已 approve" (the live bug).
    const t = approveResultText("onead/OnePixel", ref, { status: "COMMENT", commentCount: 0, incomplete: true } as never);
    assert.match(t, /未完成|REVIEW_INCOMPLETE/);
    assert.match(t, /未 approve/);
    assert.match(t, /重試|手動 review/);
    assert.doesNotMatch(t, /確認是否已 approve/);
  });
  it("reviewResultText: REVIEW_INCOMPLETE → honest 未完成 note, not a plain '已貼 review'", () => {
    const t = reviewResultText("onead/OnePixel", ref, { status: "COMMENT", commentCount: 0, incomplete: true } as never);
    assert.match(t, /未完成|REVIEW_INCOMPLETE/);
  });
  it("reviewResultText notes the exemption as a config fact, never a branch claim", () => {
    const t = reviewResultText("onead/oss-ui-v2", ref, eligibleReviewResult() as never, true, true);
    assert.match(t, /已列入 protection 豁免清單/);
    assert.doesNotMatch(
      t,
      /未啟用 dismiss-stale/,
      ":cr: never probes, so the offer line has no standing to describe the branch",
    );
  });
  it("reviewResultText leaves the offer line untouched for a non-exempt repo", () => {
    const t = reviewResultText("onead/OnePixel", ref, eligibleReviewResult() as never, true, false);
    assert.doesNotMatch(t, /豁免/);
    assert.match(t, /可進一步 approve/);
  });
  it("reviewResultText never mentions the exemption when approval is disabled", () => {
    const t = reviewResultText("onead/oss-ui-v2", ref, eligibleReviewResult() as never, false, true);
    assert.doesNotMatch(t, /豁免/, "the no-approve line must not advertise a waiver it cannot use");
    assert.match(t, /未執行 GitHub approve/);
  });
});

describe("describeMraFailure (pure)", () => {
  it("uses the last non-empty stderr line (ANSI stripped, capped) as the detail", () => {
    const { detail } = describeMraFailure({
      reason: "mra exited with code=1",
      stderr: "some warning\n\u001b[0;31mfatal: could not read Username\u001b[0m",
      stdout: "",
    } as never);
    assert.match(detail, /fatal: could not read Username/);
    assert.ok(!detail.includes("\u001b"), "ANSI escape bytes must be stripped");
    assert.ok(!/\[0;3\dm/.test(detail), "ANSI colour codes must be stripped");
  });
  it("falls back to the last stdout phase when stderr is empty (mra swallowed claude's error)", () => {
    const { detail, logDump } = describeMraFailure({
      reason: "mra exited with code=1",
      stderr: "",
      stdout: "[1;37m[review] reviewing erp[0m\n[1;37m[review] running Claude (sonnet)...[0m",
    } as never);
    assert.match(detail, /最後階段.*running Claude/);
    assert.match(logDump, /swallow|2>\/dev\/null|empty/i);
  });
});

describe("ReviewCoordinator transient-failure retry", () => {
  it("retries once after a transient mra failure, then posts the success result", async () => {
    const web = new FakeWebClient();
    let calls = 0;
    const gateway = gw({
      runMraReview: async () => {
        calls++;
        if (calls === 1) {
          return { ok: false, reason: "mra exited with code=1", stdout: "reviewing\nrunning Claude", stderr: "" };
        }
        return { ok: true, status: "APPROVED", commentCount: 0, stdout: "", stderr: "" };
      },
    } as unknown as Partial<ReviewGateway>);
    await coord(web, gateway).fromApproveMessage({
      channelId: "C1", threadTs: "1.1", userId: "U1",
      text: ":a: https://github.com/onead/OnePixel/pull/12",
    });
    assert.equal(calls, 2, "a transient mra failure must trigger exactly one retry");
    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    assert.ok(allTexts.some((t) => /已完成.*review|未執行 GitHub approve/.test(t)), "the retry's review result must be delivered");
    assert.ok(!allTexts.some((t) => /失敗/.test(t)), "no failure message when the retry succeeds");
  });

  it("after the retry also fails: posts an enriched failure (reason + detail) and logs a dump", async () => {
    const web = new FakeWebClient();
    const logs: string[] = [];
    let calls = 0;
    const gateway = gw({
      runMraReview: async () => {
        calls++;
        return {
          ok: false, reason: "mra exited with code=1",
          stdout: "[1;37m[review] running Claude (sonnet)...[0m", stderr: "",
        };
      },
    } as unknown as Partial<ReviewGateway>);
    await coord(web, gateway, (m) => logs.push(m)).fromApproveMessage({
      channelId: "C1", threadTs: "1.1", userId: "U1",
      text: ":a: https://github.com/onead/OnePixel/pull/12",
    });
    assert.equal(calls, 2, "exactly one retry before giving up");
    const allTexts = [...web.posted, ...web.updated].map((m) => m.text ?? "");
    const fail = allTexts.find((t) => /失敗/.test(t));
    assert.ok(fail, "a failure message must be posted");
    assert.match(fail!, /mra exited with code=1/, "the reason is surfaced");
    assert.match(fail!, /最後階段|running Claude/, "the last phase is surfaced so 'code=1' isn't a dead end");
    assert.ok(logs.some((l) => /FAILED/.test(l)), "a full failure dump is logged for the operator");
  });
});

describe("ReviewCoordinator progress bar on failure (frozen-bar fix)", () => {
  it("finishes the progress message with the warning text when mra returns !ok (no frozen bar)", async () => {
    const web = new FakeWebClient();
    await coord(web, gw({
      runMraReview: async () => ({ ok: false, reason: "boom", stdout: "", stderr: "" }),
    } as unknown as Partial<ReviewGateway>)).fromMessage({
      channelId: "C1",
      threadTs: "1.1",
      userId: "U1",
      text: ":cr: https://github.com/onead/OnePixel/pull/12",
    });

    // The progress message must be FINISHED with the warning text via chat.update,
    // not left frozen at "5% 準備工作區". The last chat.update must contain the
    // failure warning, not the initial frozen render.
    const lastUpdate = web.updated[web.updated.length - 1];
    assert.ok(
      lastUpdate !== undefined,
      "expected at least one chat.update (the finished progress message)",
    );
    assert.ok(
      /review 失敗|:warning:/.test(lastUpdate?.text ?? ""),
      `last chat.update must contain the failure warning, got: ${lastUpdate?.text ?? "(none)"}`,
    );
    assert.ok(
      !/準備工作區/.test(lastUpdate?.text ?? ""),
      `last chat.update must NOT be the frozen 準備工作區 render, got: ${lastUpdate?.text ?? "(none)"}`,
    );
  });
});

describe("ReviewCoordinator in-place progress bar", () => {
  it("morphs the progress message via chat.update and delivers the result via update (not a new postMessage)", async () => {
    const web = new FakeWebClient();
    const progressLines = ["reviewing onead/OnePixel#12", "loaded existing PR discussion"];
    await coord(web, gw({
      runMraReview: async (_args: unknown, opts: { onProgress?: (line: string) => void } | undefined) => {
        for (const line of progressLines) {
          opts?.onProgress?.(line);
        }
        return { ok: true, status: "APPROVED", commentCount: 0, stdout: "", stderr: "" };
      },
    } as unknown as Partial<ReviewGateway>)).fromMessage({
      channelId: "C1",
      threadTs: "1.1",
      userId: "U1",
      text: ":cr: https://github.com/onead/OnePixel/pull/12",
    });

    // At least one chat.update must contain a progress bar render (▰)
    assert.ok(
      web.updated.some((u) => (u.text ?? "").includes("▰")),
      "at least one chat.update must contain a progress bar render (▰)",
    );

    // The LAST chat.update must contain the result text, NOT a new postMessage
    const lastUpdate = web.updated[web.updated.length - 1];
    assert.ok(
      /已完成 .*review|GitHub action/.test(lastUpdate?.text ?? ""),
      "the result text must be delivered via the last chat.update (in-place), not a separate postMessage",
    );
  });
});
