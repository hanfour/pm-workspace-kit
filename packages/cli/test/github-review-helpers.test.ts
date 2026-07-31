// packages/cli/test/github-review-helpers.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  approvalProtectionReady,
  buildGhArgs_createPullRequestApproval,
  buildGhArgs_getApprovalProtection,
  buildGhArgs_getBranchRules,
  buildGhArgs_getPrHead,
  buildGhArgs_getReviewGate,
  buildGhArgs_hasPullRequestApproval,
  buildGhArgs_getAuthUser,
  createPullRequestApproval,
  createPullRequestReview,
  reviewGateStatus,
} from "../src/adapters/github";

describe("github review helper argv", () => {
  it("getAuthUser argv", () => {
    assert.deepEqual(buildGhArgs_getAuthUser(), ["api", "user", "--jq", ".login"]);
  });
  it("getPrHead argv", () => {
    assert.deepEqual(buildGhArgs_getPrHead("o/r", 12), [
      "api", "repos/o/r/pulls/12", "--jq", "{sha:.head.sha,base:.base.ref,baseSha:.base.sha,title:.title,body:.body,updatedAt:.updated_at}",
    ]);
  });
  it("builds a SHA-bound APPROVE request", () => {
    assert.deepEqual(buildGhArgs_createPullRequestApproval({ slug: "o/r", pr: 12, commitId: "abc", body: "artifact d" }), [
      "api", "--method", "POST", "repos/o/r/pulls/12/reviews",
      "-f", "event=APPROVE", "-f", "commit_id=abc", "-f", "body=artifact d",
    ]);
  });
  it("builds a commit, artifact, and actor-bound reconciliation query", () => {
    const args = buildGhArgs_hasPullRequestApproval({ slug: "o/r", pr: 12, commitId: "a".repeat(40), artifactSha256: "b".repeat(64), actor: "pmk-bot" });
    assert.match(args.at(-1)!, /commit_id.*user\.login.*contains/);
  });
  it("requires both stale-review protection controls", async () => {
    assert.deepEqual(buildGhArgs_getApprovalProtection("o/r", "main"), [
      "api", "repos/o/r/branches/main/protection", "--jq",
      "{dismissStale:.required_pull_request_reviews.dismiss_stale_reviews,requireLastPush:.required_pull_request_reviews.require_last_push_approval}",
    ]);
    const ready = await approvalProtectionReady({ slug: "o/r", branch: "main", token: "secret" }, {
      findBinary: () => "gh",
      exec: async (_file, _args, opts) => {
        assert.equal(opts.env?.GH_TOKEN, "secret");
        return { stdout: JSON.stringify({ dismissStale: true, requireLastPush: true }) };
      },
    });
    assert.equal(ready, true);
  });
  it("branch-rules argv extracts pull_request rule controls", () => {
    assert.deepEqual(buildGhArgs_getBranchRules("o/r", "main"), [
      "api", "repos/o/r/rules/branches/main", "--jq",
      '[.[] | select(.type == "pull_request") | {dismissStale: .parameters.dismiss_stale_reviews_on_push, requireLastPush: .parameters.require_last_push_approval}]',
    ]);
  });

  it("approvalProtectionReady passes on a satisfying RULESET without touching the admin endpoint (#90)", async () => {
    const endpoints: string[] = [];
    const ready = await approvalProtectionReady({ slug: "o/r", branch: "main", token: "secret" }, {
      findBinary: () => "gh",
      exec: async (_file, args, opts) => {
        endpoints.push(args[1] ?? "");
        assert.equal(opts.env?.GH_TOKEN, "secret");
        return { stdout: JSON.stringify([{ dismissStale: true, requireLastPush: true }]) };
      },
    });
    assert.equal(ready, true);
    assert.deepEqual(endpoints, ["repos/o/r/rules/branches/main"], "rulesets are read-accessible — must be tried first, alone");
  });

  it("approvalProtectionReady falls back to classic protection when no ruleset applies", async () => {
    const endpoints: string[] = [];
    const ready = await approvalProtectionReady({ slug: "o/r", branch: "main", token: "secret" }, {
      findBinary: () => "gh",
      exec: async (_file, args) => {
        endpoints.push(args[1] ?? "");
        if (args[1]?.includes("/rules/")) return { stdout: "[]" };
        return { stdout: JSON.stringify({ dismissStale: true, requireLastPush: true }) };
      },
    });
    assert.equal(ready, true);
    assert.deepEqual(endpoints, ["repos/o/r/rules/branches/main", "repos/o/r/branches/main/protection"]);
  });

  it("approvalProtectionReady is false when rules are empty and classic protection is unreadable (read-only token)", async () => {
    const ready = await approvalProtectionReady({ slug: "o/r", branch: "main", token: "secret" }, {
      findBinary: () => "gh",
      exec: async (_file, args) => {
        if (args[1]?.includes("/rules/")) return { stdout: "[]" };
        throw new Error("HTTP 404"); // admin-only endpoint, read-only token
      },
    });
    assert.equal(ready, false);
  });

  it("approvalProtectionReady is false when the ruleset lacks one of the two controls", async () => {
    const ready = await approvalProtectionReady({ slug: "o/r", branch: "main", token: "secret" }, {
      findBinary: () => "gh",
      exec: async (_file, args) => {
        if (args[1]?.includes("/rules/")) return { stdout: JSON.stringify([{ dismissStale: true, requireLastPush: false }]) };
        throw new Error("HTTP 404");
      },
    });
    assert.equal(ready, false);
  });

  it("accepts only a matching GitHub APPROVED response", async () => {
    const result = await createPullRequestApproval({ slug: "o/r", pr: 12, commitId: "abc", body: "artifact", token: "secret" }, {
      findBinary: () => "gh",
      exec: async () => ({ stdout: JSON.stringify({ id: 9, state: "APPROVED", commit_id: "abc", user: { login: "bot" } }) }),
    });
    assert.deepEqual(result, { reviewId: 9, state: "APPROVED", commitId: "abc", actor: "bot", htmlUrl: undefined });
  });
  it("posts inline findings from a private JSON input file", async () => {
    let argv: string[] = [];
    const result = await createPullRequestReview({
      slug: "o/r", pr: 12, commitId: "abc", event: "REQUEST_CHANGES", body: "summary",
      comments: [{ path: "src/a.ts", line: 7, severity: "HIGH", body: "fix it" }], token: "secret",
    }, {
      findBinary: () => "gh",
      exec: async (_file, args, opts) => {
        argv = args;
        assert.equal(opts.env?.GH_TOKEN, "secret");
        const input = args.at(-1)!;
        const payload = JSON.parse((await import("node:fs")).readFileSync(input, "utf8"));
        assert.equal(payload.commit_id, "abc");
        assert.equal(payload.event, "REQUEST_CHANGES");
        assert.deepEqual(payload.comments, [{ path: "src/a.ts", line: 7, side: "RIGHT", body: "[HIGH] fix it" }]);
        return { stdout: JSON.stringify({ id: 10, state: "CHANGES_REQUESTED", commit_id: "abc" }) };
      },
    });
    assert.deepEqual(argv.slice(0, 4), ["api", "--method", "POST", "repos/o/r/pulls/12/reviews"]);
    assert.equal(result.state, "CHANGES_REQUESTED");
  });
});

describe("reviewGateStatus (three-state review-gate probe)", () => {
  const okExec = (stdout: string) => async () => ({ stdout, stderr: "" });
  const deps = (stdout: string) => ({ exec: okExec(stdout), findBinary: () => "/usr/bin/gh" });

  it("gated: a pull_request rule requiring >=1 review → true", async () => {
    assert.equal(await reviewGateStatus({ slug: "o/r", branch: "main" }, deps("[1]") as never), true);
    assert.equal(await reviewGateStatus({ slug: "o/r", branch: "main" }, deps("[3]") as never), true);
  });

  it("ungated: empty ruleset → false", async () => {
    assert.equal(await reviewGateStatus({ slug: "o/r", branch: "main" }, deps("[]") as never), false);
  });

  it("ungated: a rule with count 0 or absent (null) → false", async () => {
    assert.equal(await reviewGateStatus({ slug: "o/r", branch: "main" }, deps("[0]") as never), false);
    assert.equal(await reviewGateStatus({ slug: "o/r", branch: "main" }, deps("[null]") as never), false);
  });

  it("unknown: an exec that throws → undefined (caller must fail closed)", async () => {
    const throwing = { exec: async () => { throw new Error("404"); }, findBinary: () => "/usr/bin/gh" };
    assert.equal(await reviewGateStatus({ slug: "o/r", branch: "main" }, throwing as never), undefined);
  });

  it("unknown: no gh binary → undefined", async () => {
    assert.equal(await reviewGateStatus({ slug: "o/r", branch: "main" }, { findBinary: () => undefined } as never), undefined);
  });

  /** gh exits 1 on a 404; the body lands on stdout and a summary on stderr. */
  const ghFailure = (stderr: string, stdout = "") => ({
    exec: async () => {
      throw Object.assign(new Error("Command failed"), { stderr, stdout });
    },
    findBinary: () => "/usr/bin/gh",
  });

  // A branch with no ruleset 404s instead of returning []. Both express the
  // same fact — no pull_request rule — so both mean "ungated".
  it("ungated: the Rules API 404s (branch has no ruleset) → false", async () => {
    const deps404 = ghFailure(
      "gh: Not Found (HTTP 404)",
      '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/repos/rules","status":"404"}',
    );
    assert.equal(await reviewGateStatus({ slug: "o/r", branch: "main" }, deps404 as never), false);
  });

  // Load-bearing: "cannot see the protection" must never read as "there is no
  // protection". Only a literal 404 may downgrade to ungated.
  it("unknown: auth/transport failures stay undefined, never false", async () => {
    for (const stderr of [
      "gh: Bad credentials (HTTP 401)",
      "gh: Resource not accessible by integration (HTTP 403)",
      "gh: Internal Server Error (HTTP 500)",
      "error connecting to api.github.com",
    ]) {
      assert.equal(
        await reviewGateStatus({ slug: "o/r", branch: "main" }, ghFailure(stderr) as never),
        undefined,
        stderr,
      );
    }
  });

  it("buildGhArgs_getReviewGate targets the Rules API and extracts the review count", () => {
    const args = buildGhArgs_getReviewGate("o/r", "main");
    assert.deepEqual(args.slice(0, 2), ["api", "repos/o/r/rules/branches/main"]);
    assert.ok(args.join(" ").includes("required_approving_review_count"));
    assert.ok(args.join(" ").includes("pull_request"));
  });
});
