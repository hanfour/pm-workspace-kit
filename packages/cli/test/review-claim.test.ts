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
});
