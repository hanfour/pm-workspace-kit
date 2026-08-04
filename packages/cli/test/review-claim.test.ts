import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

// gatewayDir() resolves under os.homedir(); existing gateway-storage tests
// isolate by overriding HOME (NOT PMK_HOME — that env var is not honored).
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-review-claim-"));
  process.env.HOME = tmp;
});
afterEach(() => {
  process.env.HOME = ORIG_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("review-claim", () => {
  const r = { owner: "o", repo: "rr", pr: 5, headSha: "abc123" };

  it("first claim wins, second loses (idempotent)", async () => {
    const { claimReview } = await import("../src/gateway/review-claim");
    assert.equal(claimReview(r), true);
    assert.equal(claimReview(r), false);
  });

  it("finalize marks done; isReviewDone true", async () => {
    const { claimReview, finalizeReview, isReviewDone } = await import("../src/gateway/review-claim");
    claimReview(r);
    finalizeReview(r, { status: "COMMENT", reviewUrl: "https://x" });
    assert.equal(isReviewDone(r), true);
  });

  it("release allows a fresh claim", async () => {
    const { claimReview, releaseReview } = await import("../src/gateway/review-claim");
    claimReview(r);
    releaseReview(r);
    assert.equal(claimReview(r), true);
  });

  it("different headSha is a separate claim (new commits → re-review)", async () => {
    const { claimReview } = await import("../src/gateway/review-claim");
    claimReview(r);
    assert.equal(claimReview({ ...r, headSha: "def456" }), true);
  });

  it("review and approve intents are separate claims for the same headSha", async () => {
    const { claimReview } = await import("../src/gateway/review-claim");
    assert.equal(claimReview({ ...r, intent: "review" }), true);
    assert.equal(claimReview({ ...r, intent: "review" }), false);
    assert.equal(claimReview({ ...r, intent: "approve" }), true);
    assert.equal(claimReview({ ...r, intent: "approve" }), false);
  });

  // The whole point of the claim is "this exact commit is never reviewed
  // twice". Folding the PR's updatedAt into the key defeated that, because the
  // bot's OWN review post bumps updatedAt — as does any teammate comment. The
  // next trigger then computed a different key, the wx create succeeded, and
  // the same commit was reviewed again. Observed live 9 times, with the verdict
  // flipping between CHANGES_REQUESTED and 0-blocker on identical code; a
  // 0-blocker result is what opens the approve offer, so a blocked PR could
  // become approvable with no code change. review.ts already refuses to pin
  // freshness on updatedAt for exactly this reason — the claim never followed.
  it("ignores PR activity: same SHA stays claimed after updatedAt moves", async () => {
    const { claimReview } = await import("../src/gateway/review-claim");
    assert.equal(claimReview({ ...r, contextVersion: "2026-07-13T08:42:44Z" }), true);
    assert.equal(
      claimReview({ ...r, contextVersion: "2026-07-14T01:20:08Z" }),
      false,
      "a bumped updatedAt must not open a second claim on the same commit",
    );
  });

  it("claim key is independent of contextVersion", async () => {
    const { reviewClaimKey } = await import("../src/gateway/review-claim");
    assert.equal(
      reviewClaimKey({ ...r, contextVersion: "2026-07-13T08:42:44Z" }),
      reviewClaimKey({ ...r, contextVersion: "2026-08-01T09:01:12Z" }),
    );
    assert.equal(reviewClaimKey({ ...r, contextVersion: "x" }), reviewClaimKey(r));
  });

  it("still separates intents and SHAs", async () => {
    const { reviewClaimKey } = await import("../src/gateway/review-claim");
    assert.notEqual(
      reviewClaimKey({ ...r, intent: "approve" }),
      reviewClaimKey({ ...r, intent: "review" }),
    );
    assert.notEqual(reviewClaimKey({ ...r, headSha: "def456" }), reviewClaimKey(r));
  });

  // Claims written before contextVersion left the key carry it as a trailing
  // segment. Shortening the key would otherwise orphan every one of them, so
  // the first trigger after upgrading would re-review an already-reviewed
  // commit -- reproducing the exact bug this change removes, once per PR.
  // Recognised on read rather than renamed on disk: production state is not
  // worth rewriting for a compatibility window.
  describe("legacy keys (contextVersion suffix)", () => {
    const claimsDir = () => path.join(tmp, ".pmk", "gateway", "reviews");
    const writeLegacy = (name: string, done: boolean) => {
      fs.mkdirSync(claimsDir(), { recursive: true });
      fs.writeFileSync(
        path.join(claimsDir(), `${name}.json`),
        JSON.stringify({ key: name, claimedAt: new Date().toISOString(), done }),
      );
    };

    it("a finalized legacy claim still blocks a re-review", async () => {
      const { claimReview, reviewClaimKey } = await import("../src/gateway/review-claim");
      writeLegacy(`${reviewClaimKey(r)}__2026-07-13T08_42_44Z`, true);
      assert.equal(claimReview(r), false);
    });

    it("an UNfinalized legacy claim does not block (it was an orphan)", async () => {
      const { claimReview, reviewClaimKey } = await import("../src/gateway/review-claim");
      writeLegacy(`${reviewClaimKey(r)}__2026-07-13T08_42_44Z`, false);
      assert.equal(claimReview(r), true);
    });

    // The approve key is the review key plus "__approve", so a naive prefix
    // match would let an approve claim block an unrelated review claim.
    it("an approve claim does not masquerade as a legacy review claim", async () => {
      const { claimReview, reviewClaimKey } = await import("../src/gateway/review-claim");
      writeLegacy(reviewClaimKey({ ...r, intent: "approve" }), true);
      assert.equal(claimReview(r), true, "review intent must be unaffected");
    });
  });

  it("forceClaimReview archives a finalized claim and reclaims the same SHA", async () => {
    const { claimReview, finalizeReview, forceClaimReview } = await import("../src/gateway/review-claim");
    claimReview(r);
    finalizeReview(r, { status: "COMMENT" });
    assert.equal(forceClaimReview(r), true);
    assert.equal(forceClaimReview(r), false, "an active forced claim cannot be stolen");
    const files = fs.readdirSync(path.join(tmp, ".pmk", "gateway", "reviews"));
    assert.ok(files.some((name) => name.includes(".history.")), "prior finalized claim history is retained");
  });
});

describe("recoverReviewClaims (B self-heal)", () => {
  const r = { owner: "o", repo: "rr", pr: 9, headSha: "sha9" };
  const claimFilePath = async (): Promise<string> => {
    const { reviewClaimKey } = await import("../src/gateway/review-claim");
    return path.join(tmp, ".pmk", "gateway", "reviews", `${reviewClaimKey(r)}.json`);
  };
  const ageFile = (p: string, ms: number): void => {
    const t = new Date(Date.now() - ms);
    fs.utimesSync(p, t, t);
  };

  it("releases a stale non-finalized claim → PR can be re-claimed", async () => {
    const { claimReview, recoverReviewClaims } = await import("../src/gateway/review-claim");
    claimReview(r);
    const claimPath = await claimFilePath();
    const record = JSON.parse(fs.readFileSync(claimPath, "utf8"));
    fs.writeFileSync(claimPath, JSON.stringify({ ...record, ownerPid: 999_999_999 }));
    ageFile(claimPath, 60 * 60 * 1000); // 1h old (orphaned mid-review)
    const warns: string[] = [];
    const n = recoverReviewClaims(10 * 60 * 1000, (m) => warns.push(m)); // 10m window
    assert.equal(n, 1);
    assert.match(warns[0], /recovered orphaned review claim/);
    assert.equal(claimReview(r), true); // released → a fresh claim now succeeds
  });

  it("keeps a FINALIZED claim even when old (idempotency preserved)", async () => {
    const { claimReview, finalizeReview, recoverReviewClaims, isReviewDone } = await import(
      "../src/gateway/review-claim"
    );
    claimReview(r);
    finalizeReview(r, { status: "APPROVED" });
    ageFile(await claimFilePath(), 60 * 60 * 1000);
    assert.equal(recoverReviewClaims(10 * 60 * 1000, () => {}), 0);
    assert.equal(isReviewDone(r), true);
  });

  it("keeps a RECENT non-finalized claim (orphaned mra may still be finishing)", async () => {
    const { claimReview, recoverReviewClaims } = await import("../src/gateway/review-claim");
    claimReview(r); // mtime ~ now
    assert.equal(recoverReviewClaims(45 * 60 * 1000, () => {}), 0); // 45m window
    assert.equal(claimReview(r), false); // still claimed
  });

  it("keeps a stale claim while its owner process is still alive", async () => {
    const { claimReview, recoverReviewClaims } = await import("../src/gateway/review-claim");
    claimReview(r);
    ageFile(await claimFilePath(), 60 * 60 * 1000);
    assert.equal(recoverReviewClaims(1000, () => {}), 0);
  });

  it("returns 0 safely when no claims exist", async () => {
    const { recoverReviewClaims } = await import("../src/gateway/review-claim");
    assert.equal(recoverReviewClaims(1000, () => {}), 0);
  });
});
