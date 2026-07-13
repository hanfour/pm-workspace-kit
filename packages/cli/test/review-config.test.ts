import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normaliseRawConfigForTest, resolveReviewConfig } from "../src/gateway/config";

describe("resolveReviewConfig", () => {
  it("applies safe defaults", () => {
    const c = resolveReviewConfig(undefined);
    assert.equal(c.enabled, false);          // off until configured
    assert.equal(c.approval.enabled, false); // separate kill switch
    assert.equal(c.allowPublicRepos, false);
    assert.equal(c.maxPrsPerTrigger, 5);
    assert.equal(c.maxConcurrent, 2);
    assert.equal(c.maxConcurrentPerUser, 1);
    assert.equal(c.strategy, "standard");
    assert.equal(c.providerMode, "codex");
  });
  it("preserves Claude/debate for an existing pre-provider review block", () => {
    const raw = normaliseRawConfigForTest({ version: 1, admins: [], blocklist: [], slack: {}, review: { enabled: true } });
    const review = resolveReviewConfig(raw.review);
    assert.equal(review.providerMode, "claude");
    assert.equal(review.strategy, "debate");
  });
  it("respects overrides and clamps the cap to >=1", () => {
    const c = resolveReviewConfig({
      enabled: true,
      approval: { enabled: true },
      maxPrsPerTrigger: 0,
      strategy: "personas",
      providerMode: "claude",
    });
    assert.equal(c.enabled, true);
    assert.equal(c.approval.enabled, true);
    assert.equal(c.maxPrsPerTrigger, 1);
    assert.equal(c.strategy, "personas");
    assert.equal(c.providerMode, "claude");
  });
  it("supports fallback and dual provider modes", () => {
    assert.equal(resolveReviewConfig({ providerMode: "fallback" }).providerMode, "fallback");
    assert.equal(resolveReviewConfig({ providerMode: "dual" }).providerMode, "dual");
  });
});
