// packages/cli/test/review-coordinator.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { FakeWebClient } from "./harness/slack-fakes";
import { ReviewCoordinator, isReviewRequest, isRetryRequest, isApproveRequest, type ReviewGateway } from "../src/gateway/slack/review";
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
    runMraAnalyze: async () => ({ ok: true, stdout: "", stderr: "" }),
    pkbNeedsBuild: () => false,
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
    })).fromReaction({ channelId: "C1", messageTs: "1.1", reactorUserId: "U1" });
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
  it("threads review.ghToken to getAuthUser (actor-verify) AND runMraReview", async () => {
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
    assert.equal(mraArgs?.ghToken, "gho_pinned", "mra POST must use the pinned token");
  });
});

describe("ReviewCoordinator allowApprove forwarding", () => {
  it("passes review.allowApprove=true from config into runMraReview", async () => {
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
      review: { enabled: true, expectedGhUser: "expected-bot", allowApprove: true },
    } as never;
    const c = new ReviewCoordinator({ web: web as never, config, onLog: () => {}, gateway });
    await c.fromMessage({
      channelId: "C1", threadTs: "1.1", userId: "U1",
      text: ":cr: https://github.com/onead/OnePixel/pull/12",
    });
    assert.equal(mraArgs?.allowApprove, true, "runMraReview must receive allowApprove=true from config");
  });
});

describe("ReviewCoordinator immediate ack (detached UX)", () => {
  it("posts the '收到，背景 review' ack BEFORE the slow per-PR work", async () => {
    const web = new FakeWebClient();
    let ackedBeforeReview = false;
    const gateway = gw({
      runMraReview: async () => {
        // by the time mra runs, the ack must already be on the thread
        ackedBeforeReview = web.posted.some((p) =>
          /收到.*背景 review/.test(p.text ?? ""),
        );
        return { ok: true, status: "COMMENT", commentCount: 0, stdout: "", stderr: "" };
      },
    } as unknown as Partial<ReviewGateway>);
    await coord(web, gateway).fromMessage({
      channelId: "C1", threadTs: "1.1", userId: "U1",
      text: ":cr: https://github.com/onead/OnePixel/pull/12",
    });
    assert.equal(ackedBeforeReview, true, "ack must precede the per-PR review work");
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
      after.some((p) => /已經 review 過/.test(p.text ?? "")),
      "second review of the same commit must post an 'already reviewed' note, not stay silent",
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
  it("matches a bare retry / 重試 / 重跑 (trimmed, case-insensitive)", () => {
    for (const t of ["retry", "  Retry ", "RETRY", "重試", "重跑"]) {
      assert.equal(isRetryRequest(t), true, `should match: '${t}'`);
    }
  });
  it("does NOT match chat that merely contains 'retry'", () => {
    for (const t of ["please retry", "retry the build", "", ":cr: x"]) {
      assert.equal(isRetryRequest(t), false, `should not match: '${t}'`);
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

    // The LAST chat.update must contain the result text (已對), NOT a new postMessage
    const lastUpdate = web.updated[web.updated.length - 1];
    assert.ok(
      (lastUpdate?.text ?? "").includes("已對"),
      "the result text must be delivered via the last chat.update (in-place), not a separate postMessage",
    );
  });
});
