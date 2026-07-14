import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewMraArgs,
  runMraReviewWithRetry,
  postProtocolV1Review,
} from "../src/gateway/slack/review-backend";
import type { MraReviewResult } from "../src/adapters/mra";

const okRes = (over: Partial<MraReviewResult> = {}): MraReviewResult => ({
  ok: true,
  status: "COMMENT",
  stdout: "",
  stderr: "",
  ...over,
});
const failRes = (over: Partial<MraReviewResult> = {}): MraReviewResult => ({
  ok: false,
  reason: "exited with code=1",
  stdout: "",
  stderr: "boom",
  ...over,
});
const noopBackoff = async () => {};
const liveSignal = { aborted: false } as AbortSignal;
const abortedSignal = { aborted: true } as AbortSignal;
const retryOpts = (signal: AbortSignal) => ({
  onProgress: () => {},
  onLog: () => {},
  backoff: noopBackoff,
  signal,
  label: "review o/r#1",
});

describe("buildReviewMraArgs", () => {
  it("maps params into the mra review args (baseRef from prep, sha/baseSha from head)", () => {
    const signal = liveSignal;
    const args = buildReviewMraArgs({
      reviewWorkspace: "/ws",
      project: "proj",
      pr: 7,
      strategy: "standard",
      providerMode: "codex",
      head: { sha: "abc", baseSha: "base", title: "T", body: "B", updatedAt: "u" },
      baseRef: "release/x",
      signal,
    });
    assert.equal(args.workspace, "/ws");
    assert.equal(args.cwd, "/ws");
    assert.equal(args.project, "proj");
    assert.equal(args.pr, 7);
    assert.equal(args.strategy, "standard");
    assert.equal(args.providerMode, "codex");
    assert.equal(args.expectedHeadSha, "abc");
    assert.equal(args.baseRef, "release/x");
    assert.equal(args.baseSha, "base");
    assert.deepEqual(args.prContext, { title: "T", body: "B", updatedAt: "u" });
    assert.equal(args.signal, signal);
  });
});

describe("runMraReviewWithRetry", () => {
  const gw = (results: MraReviewResult[]) => {
    let i = 0;
    const calls: unknown[] = [];
    return {
      calls,
      gateway: {
        runMraReview: async (a: unknown) => {
          calls.push(a);
          return results[Math.min(i++, results.length - 1)];
        },
      },
    };
  };

  it("does not retry a clean first result", async () => {
    const { gateway, calls } = gw([okRes()]);
    const { res, retried } = await runMraReviewWithRetry(gateway, {} as never, retryOpts(liveSignal));
    assert.equal(calls.length, 1);
    assert.equal(retried, false);
    assert.equal(res.ok, true);
  });

  it("retries once on a transient failure and recovers", async () => {
    const { gateway, calls } = gw([failRes(), okRes()]);
    const { res, retried } = await runMraReviewWithRetry(gateway, {} as never, retryOpts(liveSignal));
    assert.equal(calls.length, 2);
    assert.equal(retried, true);
    assert.equal(res.ok, true);
  });

  it("retries once on REVIEW_INCOMPLETE (exit-0) and recovers", async () => {
    const { gateway, calls } = gw([okRes({ incomplete: true }), okRes()]);
    const { res, retried } = await runMraReviewWithRetry(gateway, {} as never, retryOpts(liveSignal));
    assert.equal(calls.length, 2);
    assert.equal(retried, true);
    assert.equal(res.incomplete, undefined);
  });

  it("returns the still-failing result after a retry", async () => {
    const { gateway, calls } = gw([failRes(), failRes({ reason: "still bad" })]);
    const { res, retried } = await runMraReviewWithRetry(gateway, {} as never, retryOpts(liveSignal));
    assert.equal(calls.length, 2);
    assert.equal(retried, true);
    assert.equal(res.ok, false);
  });

  it("does not retry when the signal is already aborted (shutdown drain)", async () => {
    const { gateway, calls } = gw([failRes(), okRes()]);
    const { retried } = await runMraReviewWithRetry(gateway, {} as never, retryOpts(abortedSignal));
    assert.equal(calls.length, 1);
    assert.equal(retried, false);
  });
});

describe("postProtocolV1Review", () => {
  const makeConfig = (reviewOver: Record<string, unknown> = {}, blocklist: string[] = []) =>
    ({
      version: 1,
      admins: [],
      blocklist,
      audience: {},
      escalation: {},
      slack: {},
      github: {},
      review: { enabled: true, expectedGhUser: "bot", ...reviewOver },
    }) as never;

  const ref = { owner: "o", repo: "r", number: 3, url: "https://x/3" } as never;

  const gw = (over: Record<string, unknown> = {}) => ({
    getAuthUser: async () => "bot",
    getPrHead: async () => ({ sha: "HEAD", baseRef: "main" }),
    createPullRequestReview: async (a: { event: string }) => ({
      reviewId: 1,
      state: a.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED",
      commitId: "HEAD",
      actor: "bot",
    }),
    ...over,
  }) as never;

  it("skips (policy-revoked) when review has been disabled", async () => {
    const r = await postProtocolV1Review(gw(), {
      config: makeConfig({ enabled: false }),
      slug: "o/r", ref, headSha: "HEAD", reactorUserId: "U1", res: okRes(),
    });
    assert.deepEqual(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "policy-revoked");
  });

  it("skips (policy-revoked) when the actor is on the blocklist", async () => {
    const r = await postProtocolV1Review(gw(), {
      config: makeConfig({}, ["U1"]),
      slug: "o/r", ref, headSha: "HEAD", reactorUserId: "U1", res: okRes(),
    });
    assert.equal(r.ok, false);
  });

  it("skips (policy-revoked) when the repo left the allowlist", async () => {
    const r = await postProtocolV1Review(gw(), {
      config: makeConfig({ repoAllowlist: ["other/repo"] }),
      slug: "o/r", ref, headSha: "HEAD", reactorUserId: "U1", res: okRes(),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "policy-revoked");
  });

  it("skips (gh-actor-revoked) when the posting identity changed", async () => {
    const r = await postProtocolV1Review(gw({ getAuthUser: async () => "someone-else" }), {
      config: makeConfig(),
      slug: "o/r", ref, headSha: "HEAD", reactorUserId: "U1", res: okRes(),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "gh-actor-revoked");
  });

  it("skips (review-head-changed) when the head moved during analysis", async () => {
    const r = await postProtocolV1Review(gw({ getPrHead: async () => ({ sha: "NEWHEAD" }) }), {
      config: makeConfig(),
      slug: "o/r", ref, headSha: "HEAD", reactorUserId: "U1", res: okRes(),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "review-head-changed");
  });

  it("posts a COMMENT review and returns the GitHub state on success", async () => {
    let posted: { event: string } | undefined;
    const r = await postProtocolV1Review(
      gw({ createPullRequestReview: async (a: { event: string }) => { posted = a; return { reviewId: 1, state: "COMMENTED", commitId: "HEAD", actor: "bot" }; } }),
      { config: makeConfig(), slug: "o/r", ref, headSha: "HEAD", reactorUserId: "U1", res: okRes({ status: "COMMENT" }) },
    );
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.status, "COMMENTED");
    assert.equal(posted?.event, "COMMENT");
  });

  it("maps a CHANGES_REQUESTED result to a REQUEST_CHANGES event", async () => {
    let posted: { event: string } | undefined;
    const r = await postProtocolV1Review(
      gw({ createPullRequestReview: async (a: { event: string }) => { posted = a; return { reviewId: 1, state: "CHANGES_REQUESTED", commitId: "HEAD", actor: "bot" }; } }),
      { config: makeConfig(), slug: "o/r", ref, headSha: "HEAD", reactorUserId: "U1", res: okRes({ status: "CHANGES_REQUESTED" }) },
    );
    assert.equal(r.ok, true);
    assert.equal(posted?.event, "REQUEST_CHANGES");
  });
});
