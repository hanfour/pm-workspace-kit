// packages/cli/test/review-already-reviewed.test.ts
//
// The skip note a trigger gets when this exact commit was already reviewed.
// Live incident 2026-08-12 (onead/finance-system#363): the note said only
// "already reviewed — push a new commit to re-review". The user HAD pushed the
// fix, it HAD been reviewed clean, and an approve offer was waiting — so the
// one sentence they got sent them off to push a commit that did not exist.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { alreadyReviewedMessage } from "../src/gateway/slack/review-messages";

const base = {
  slug: "onead/finance-system",
  pr: 363,
  headSha: "f3117a7d79cb8c57e79308477c3086dfc4f2bb6b",
  intent: "review" as const,
};

describe("alreadyReviewedMessage", () => {
  it("reports WHAT the prior review decided and WHERE to read it", () => {
    const text = alreadyReviewedMessage({
      ...base,
      prior: {
        status: "COMMENTED",
        blockerCount: 0,
        commentCount: 1,
        reviewUrl: "https://github.com/onead/finance-system/pull/363",
        finalizedAt: "2026-08-12T06:54:59.547Z",
      },
    });
    assert.match(text, /f3117a7/, "names the commit that was skipped");
    assert.match(text, /COMMENTED/, "carries the prior verdict");
    assert.match(text, /0 個 blocker/, "carries the blocker count");
    assert.match(text, /1 則/, "carries the comment count");
    assert.match(text, /https:\/\/github\.com\/onead\/finance-system\/pull\/363/, "links the review");
    assert.match(text, /14:54/, "states when it was reviewed, in Taipei time");
  });

  it("points a waiting approve offer at `approve` instead of telling the user to push", () => {
    const text = alreadyReviewedMessage({
      ...base,
      origin: "a",
      approveOfferPending: true,
      prior: { status: "COMMENTED", blockerCount: 0, finalizedAt: "2026-08-12T06:54:59.547Z" },
    });
    assert.match(text, /回覆 `approve`/, "the pending offer is the next step");
    assert.doesNotMatch(
      text,
      /推新 commit|push 後再發/,
      "must not send someone who wants to approve off to push a commit",
    );
  });

  // 2026-08-14 (finance-system#378): the note offered a bare `rerun`, which has
  // to re-read the thread root — the exact call that fails in a channel the bot
  // lacks `channels:history` for. The admin was handed a command this note had
  // just recommended and could not run. It now names the PR, so the command is
  // self-contained wherever it is pasted.
  it("offers an admin a self-contained `rerun` that names the PR", () => {
    const text = alreadyReviewedMessage({ ...base, isAdmin: true, prior: { status: "COMMENTED" } });
    assert.match(
      text,
      /`rerun https:\/\/github\.com\/onead\/finance-system\/pull\/363`/,
      "an admin has a way to re-review the same commit that does not depend on a thread read",
    );
  });

  it("does not offer `rerun` to a non-admin who cannot use it", () => {
    const text = alreadyReviewedMessage({ ...base, isAdmin: false, prior: { status: "COMMENTED" } });
    assert.doesNotMatch(text, /rerun/, "advice a non-admin cannot act on is a dead end");
  });

  it("still reads cleanly when the claim predates outcome recording", () => {
    const text = alreadyReviewedMessage(base);
    assert.doesNotMatch(text, /undefined|NaN/, "no placeholder leakage from a missing record");
    assert.match(text, /不重複審/, "the reason for the skip still comes through");
    assert.match(text, /push/, "and the way forward is still stated");
  });

  it("uses approve wording when an approve check (not a review) was skipped", () => {
    const text = alreadyReviewedMessage({
      ...base,
      intent: "approve",
      prior: { status: "APPROVED", finalizedAt: "2026-08-12T06:54:59.547Z" },
    });
    assert.match(text, /approve/, "names the operation that was skipped");
    assert.doesNotMatch(text, /已經 review 過了/, "an approve skip must not be described as a review skip");
  });
});
