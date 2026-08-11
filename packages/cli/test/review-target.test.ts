import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { resolveReviewTarget } from "../src/gateway/slack/review-target";

/**
 * These six guards decide whether a PR may be reviewed AT ALL, and two of them
 * are containment controls: the allowlist, and the refusal to review a public
 * repo (which would leak internal analysis into a public PR). They lived inside
 * runOne's 320 lines, so exercising them meant driving the whole coordinator —
 * claims, progress bar, workspace clone and mra backend included. Extracted so
 * the decision can be tested as a decision.
 */
const ref = { owner: "o", repo: "r", number: 7, url: "https://github.com/o/r/pull/7" };

const head = { sha: "a".repeat(40), baseRef: "main", updatedAt: "2026-08-01T00:00:00Z" };

function gw(over: Record<string, unknown> = {}) {
  return {
    resolveProjectByRemote: () => "proj",
    resolveRepoSlug: async () => "o/r",
    listPrDiscussion: async () => [],
    getPrHead: async () => head,
    repoVisibility: async () => "private",
    ...over,
  } as never;
}

const ctx = (over: Record<string, unknown> = {}) =>
  ({
    workspace: "/ws",
    review: { allowPublicRepos: false },
    token: "t",
    ...over,
  }) as never;

describe("resolveReviewTarget", () => {
  it("returns the resolved target when every guard passes", async () => {
    const res = await resolveReviewTarget(ref, ctx(), gw());
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.project, "proj");
      assert.equal(res.slug, "o/r");
      assert.equal(res.head.sha, head.sha);
    }
  });

  it("refuses a repo that is not in the mra workspace", async () => {
    const res = await resolveReviewTarget(ref, ctx(), gw({ resolveProjectByRemote: () => undefined }));
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.reason, "not-in-workspace");
      assert.match(res.message, /不在 mra workspace/);
    }
  });

  it("refuses when the GitHub slug cannot be derived", async () => {
    const res = await resolveReviewTarget(ref, ctx(), gw({ resolveRepoSlug: async () => undefined }));
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "slug");
  });

  it("refuses when the PR head is unreadable", async () => {
    const res = await resolveReviewTarget(ref, ctx(), gw({ getPrHead: async () => undefined }));
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "pr-head");
  });

  // An approve authorised one commit. If a new one landed since, the approve
  // must not silently apply to code nobody reviewed.
  it("refuses when a new commit landed after the approve authorisation", async () => {
    const res = await resolveReviewTarget(
      ref,
      ctx({ authorizedHeads: new Map([["o/r#7", "b".repeat(40)]]) }),
      gw(),
    );
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.reason, "approval-head-changed");
      assert.match(res.message, /未 approve/);
    }
  });

  it("accepts when the authorised head still matches", async () => {
    const res = await resolveReviewTarget(
      ref,
      ctx({ authorizedHeads: new Map([["o/r#7", head.sha]]) }),
      gw(),
    );
    assert.equal(res.ok, true);
  });

  it("refuses a repo outside the allowlist", async () => {
    const res = await resolveReviewTarget(
      ref,
      ctx({ review: { allowPublicRepos: false, repoAllowlist: ["other/repo"] } }),
      gw(),
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "allowlist");
  });

  // Containment: reviewing a public repo would publish internal analysis.
  // "unknown" must fail closed alongside "public".
  for (const vis of ["public", "unknown"]) {
    it(`refuses a ${vis} repo when allowPublicRepos is off`, async () => {
      const res = await resolveReviewTarget(ref, ctx(), gw({ repoVisibility: async () => vis }));
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.reason, "public-repo");
    });
  }

  it("skips the visibility probe entirely when allowPublicRepos is on", async () => {
    let probed = false;
    const res = await resolveReviewTarget(
      ref,
      ctx({ review: { allowPublicRepos: true } }),
      gw({
        repoVisibility: async () => {
          probed = true;
          return "public";
        },
      }),
    );
    assert.equal(res.ok, true);
    assert.equal(probed, false, "no probe should be issued when the guard is disabled");
  });

  // Ordering is load-bearing: both containment guards must be settled before a
  // claim is taken, so a refused PR never burns one.
  it("checks the allowlist before spending a visibility probe", async () => {
    let probed = false;
    await resolveReviewTarget(
      ref,
      ctx({ review: { allowPublicRepos: false, repoAllowlist: ["other/repo"] } }),
      gw({
        repoVisibility: async () => {
          probed = true;
          return "private";
        },
      }),
    );
    assert.equal(probed, false);
  });
});
