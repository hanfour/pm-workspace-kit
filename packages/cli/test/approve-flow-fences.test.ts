import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ApproveFlow, type ApproveFlowDeps } from "../src/gateway/slack/review-approve-flow";
import type { ApprovalReservation } from "../src/gateway/review-approval";

/**
 * `publishReservation` runs three revision fences. Each re-reads live gateway
 * config, so a policy change landing mid-approve — an admin revoked, the repo
 * dropped from the allowlist, approval switched off — is caught before the
 * GitHub POST. These tests hold that property directly, by handing in a
 * `currentConfig` that returns a DIFFERENT config on later calls.
 *
 * What these tests guard: that the METHOD keeps re-reading. Hoisting the first
 * read into a single `const live` reused by all three fences would leave them
 * comparing one value against itself — always passing — and no
 * coordinator-level test would notice, because the wiring would still be
 * correct and the fences would simply always agree.
 *
 * What they do NOT guard, despite an earlier claim to the contrary: the
 * COORDINATOR's wiring of `currentConfig`. Both ways of breaking it are
 * already caught, verified empirically:
 *
 *   currentConfig: this.currentConfig()   → TS2322, does not compile
 *   currentConfig: this.currentConfig     → compiles, but loses `this`;
 *                                           review-coordinator.test.ts fails 21×
 *
 * These tests bypass ReviewCoordinator entirely, so they pass under either
 * break. Keeping the distinction straight matters: a test file that claims to
 * guard something it cannot is worse than no test, because it stops anyone
 * from writing the one that would.
 */

// Never point HOME back at the operator's home. Test files run in separate
// processes, so restoring buys nothing — and it opens a window that has
// already caused an outage: a cancelled test's abandoned continuation resumes
// AFTER afterEach, sees the real HOME, and writes to the live ~/.pmk. On
// 2026-08-04 that overwrote the gateway config with test fixtures and took
// the bot down. ORIG_HOME is a throwaway directory, never the real one.
const ORIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-safe-home-"));
process.env.HOME = ORIG_HOME;
let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-approve-fences-"));
  process.env.HOME = tmp;
});
afterEach(() => {
  process.env.HOME = ORIG_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const HEAD = "a".repeat(40);
const ARTIFACT = "b".repeat(64);

function config(over: Record<string, unknown> = {}) {
  return {
    version: 3,
    admins: ["U_ADMIN"],
    blocklist: [],
    audience: { default: "biz", users: {}, channels: {}, domainExamples: { biz: [], pm: [] } },
    escalation: { default: [], repos: {} },
    slack: {},
    github: { token: "gh-token" },
    review: {
      enabled: true,
      approval: { enabled: true, allowWhenNoReviewGate: true },
      providerMode: "codex",
    },
    ...over,
  } as never;
}

function reservation(): ApprovalReservation {
  // The reservation file must exist on disk: both terminal paths
  // (consumeApprovalReservation on success, releaseApprovalReservation /
  // markApprovalPendingReconcile on failure) rename it.
  const reservedPath = path.join(tmp, "reserved.json");
  fs.writeFileSync(reservedPath, JSON.stringify({ channelId: "C1", threadTs: "1.1" }));
  return {
    id: "res-1",
    channelId: "C1",
    threadTs: "1.1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    reservedPath,
    refs: [
      {
        owner: "o",
        repo: "r",
        number: 7,
        url: "https://github.com/o/r/pull/7",
        headSha: HEAD,
        baseRef: "main",
        artifactSha256: ARTIFACT,
      },
    ],
  };
}

/** Records every GitHub call so a test can assert the POST never happened. */
function deps(over: Partial<ApproveFlowDeps> = {}) {
  const posted: unknown[] = [];
  const replies: string[] = [];
  const base: ApproveFlowDeps = {
    gateway: {
      getAuthUser: async () => "pmk-bot",
      getPrHead: async () => ({ sha: HEAD, baseRef: "main", updatedAt: "2026-08-01T00:00:00Z" }),
      approvalProtectionReady: async () => true,
      reviewGateStatus: async () => false,
      createPullRequestApproval: async (a: unknown) => {
        posted.push(a);
        return { reviewId: 1, state: "APPROVED", commitId: HEAD };
      },
      hasPullRequestApproval: async () => false,
    } as never,
    currentConfig: () => config(),
    fetchMessageText: async () => undefined,
    reply: async (_c, _t, text) => {
      replies.push(text);
    },
    ...over,
  };
  return { deps: base, posted, replies };
}

describe("publishReservation revision fences", () => {
  it("approves when policy is unchanged across all three reads", async () => {
    const { deps: d, posted } = deps();
    await new ApproveFlow(d).publishReservation(reservation(), "U_ADMIN");
    assert.equal(posted.length, 1, "a stable policy must reach the GitHub POST");
  });

  // The core guard: the method must READ config again after the first fence.
  // Hoisting that read would make every fence compare a value against itself.
  it("refuses when live policy changes between the first and second read", async () => {
    let call = 0;
    const { deps: d, posted, replies } = deps({
      currentConfig: () => {
        call += 1;
        // First read: U_ADMIN is an admin. Every read after: revoked.
        return call === 1 ? config() : config({ admins: ["U_SOMEONE_ELSE"] });
      },
    });

    await new ApproveFlow(d).publishReservation(reservation(), "U_ADMIN");

    assert.equal(posted.length, 0, "a revoked admin must not reach the GitHub POST");
    assert.ok(
      replies.some((r) => /preflight 未通過/.test(r)),
      `expected a preflight refusal, got: ${JSON.stringify(replies)}`,
    );
    assert.ok(call >= 2, "the method must re-read config, not reuse the first read");
  });

  it("refuses when the repo leaves the allowlist mid-approve", async () => {
    let call = 0;
    const { deps: d, posted } = deps({
      currentConfig: () => {
        call += 1;
        return call === 1
          ? config()
          : config({ review: { enabled: true, approval: { enabled: true, allowWhenNoReviewGate: true }, providerMode: "codex", repoAllowlist: ["other/repo"] } });
      },
    });
    await new ApproveFlow(d).publishReservation(reservation(), "U_ADMIN");
    assert.equal(posted.length, 0);
  });

  it("refuses when approval is switched off mid-approve", async () => {
    let call = 0;
    const { deps: d, posted } = deps({
      currentConfig: () => {
        call += 1;
        return call === 1
          ? config()
          : config({ review: { enabled: true, approval: { enabled: false }, providerMode: "codex" } });
      },
    });
    await new ApproveFlow(d).publishReservation(reservation(), "U_ADMIN");
    assert.equal(posted.length, 0);
  });

  // The fences guard policy; this guards the code being approved.
  it("refuses when the PR head moves after the authorisation", async () => {
    const { deps: d, posted } = deps({
      gateway: {
        getAuthUser: async () => "pmk-bot",
        getPrHead: async () => ({ sha: "c".repeat(40), baseRef: "main" }),
        approvalProtectionReady: async () => true,
        reviewGateStatus: async () => false,
        createPullRequestApproval: async () => ({ reviewId: 1, state: "APPROVED", commitId: HEAD }),
        hasPullRequestApproval: async () => false,
      } as never,
    });
    await new ApproveFlow(d).publishReservation(reservation(), "U_ADMIN");
    assert.equal(posted.length, 0, "a new commit must invalidate the authorisation");
  });

  it("refuses a multi-PR reservation outright", async () => {
    const { deps: d, posted } = deps();
    const multi = reservation();
    multi.refs = [...multi.refs, { ...multi.refs[0], number: 8 }];
    await new ApproveFlow(d).publishReservation(multi, "U_ADMIN");
    assert.equal(posted.length, 0);
  });
});
