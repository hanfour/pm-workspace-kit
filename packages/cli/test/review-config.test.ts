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

  it("defaults protectionExemptions to an empty array", () => {
    assert.deepEqual(resolveReviewConfig({}).approval.protectionExemptions, []);
    assert.deepEqual(resolveReviewConfig({ approval: { enabled: true } }).approval.protectionExemptions, []);
  });

  it("keeps well-formed protectionExemptions and trims them", () => {
    const c = resolveReviewConfig({
      approval: { enabled: true, protectionExemptions: [{ repo: "  onead/oss-ui-v2 ", reason: " ruleset pending " }] },
    });
    assert.deepEqual(c.approval.protectionExemptions, [{ repo: "onead/oss-ui-v2", reason: "ruleset pending" }]);
  });

  it("drops exemptions that lack a non-empty reason — the waiver must be justified", () => {
    const c = resolveReviewConfig({
      approval: {
        enabled: true,
        protectionExemptions: [
          { repo: "onead/a" } as never,
          { repo: "onead/b", reason: "" } as never,
          { repo: "onead/c", reason: "   " } as never,
          { repo: "onead/d", reason: 42 } as never,
        ],
      },
    });
    assert.deepEqual(c.approval.protectionExemptions, [], "an unjustified waiver must never take effect");
  });

  it("drops malformed entries but keeps valid siblings and the surrounding config", () => {
    const c = resolveReviewConfig({
      enabled: true,
      approval: {
        enabled: true,
        protectionExemptions: [
          null as never,
          "onead/string-form" as never,
          { reason: "no repo" } as never,
          { repo: "onead/good", reason: "kept" },
        ],
      },
    });
    assert.deepEqual(c.approval.protectionExemptions, [{ repo: "onead/good", reason: "kept" }]);
    assert.equal(c.enabled, true, "one bad exemption must not take the config down");
    assert.equal(c.approval.enabled, true);
  });
});
