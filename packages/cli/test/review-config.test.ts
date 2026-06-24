import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveReviewConfig } from "../src/gateway/config";

describe("resolveReviewConfig", () => {
  it("applies safe defaults", () => {
    const c = resolveReviewConfig(undefined);
    assert.equal(c.enabled, false);          // off until configured
    assert.equal(c.allowPublicRepos, false);
    assert.equal(c.maxPrsPerTrigger, 5);
    assert.equal(c.strategy, "debate");
  });
  it("respects overrides and clamps the cap to >=1", () => {
    const c = resolveReviewConfig({ enabled: true, maxPrsPerTrigger: 0, strategy: "personas" });
    assert.equal(c.enabled, true);
    assert.equal(c.maxPrsPerTrigger, 1);
    assert.equal(c.strategy, "personas");
  });
});
