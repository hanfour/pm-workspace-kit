import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

// gatewayDir() resolves under os.homedir(); existing gateway-storage tests
// isolate by overriding HOME (NOT PMK_HOME — that env var is not honored).
const ORIG_HOME = process.env.HOME;
let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-review-claim-"));
  process.env.HOME = tmp;
});
afterEach(() => {
  if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
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
