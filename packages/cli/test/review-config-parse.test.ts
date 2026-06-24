import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  normaliseRawConfigForTest,
  resolveReviewConfig,
  resolveReviewGhToken,
} from "../src/gateway/config";

// Regression: the config PARSER (normaliseRawConfig) must carry the `review`
// block through onto GatewayConfig. It was originally omitted from the
// field-by-field parse — so `review.enabled:true` in gateway.json was silently
// dropped and the gateway reported "review off" no matter what. resolveReviewConfig
// was unit-tested in isolation, which did not catch the missing parser wiring.
describe("review config parse", () => {
  it("carries the review block through the parser", () => {
    const c = normaliseRawConfigForTest({
      version: 1,
      review: {
        enabled: true,
        expectedGhUser: "HanfourHuangOneAD",
        strategy: "debate",
        allowPublicRepos: false,
      },
    });
    assert.deepEqual(c.review, {
      enabled: true,
      expectedGhUser: "HanfourHuangOneAD",
      strategy: "debate",
      allowPublicRepos: false,
    });
    // and it resolves to an enabled, debate-strategy config
    const resolved = resolveReviewConfig(c.review);
    assert.equal(resolved.enabled, true);
    assert.equal(resolved.strategy, "debate");
    assert.equal(resolved.expectedGhUser, "HanfourHuangOneAD");
  });

  it("drops junk fields and a bad strategy, keeps valid ones", () => {
    const c = normaliseRawConfigForTest({
      version: 1,
      review: {
        enabled: true,
        strategy: "bogus", // invalid → dropped (resolveReviewConfig defaults to debate)
        repoAllowlist: ["onead/erp", 7, "onead/masa"], // non-strings filtered by asStringArray
        nonsense: "x", // unknown key → dropped
      },
    });
    assert.equal(c.review?.enabled, true);
    assert.equal((c.review as Record<string, unknown>).strategy, undefined);
    assert.equal((c.review as Record<string, unknown>).nonsense, undefined);
    assert.deepEqual(c.review?.repoAllowlist, ["onead/erp", "onead/masa"]);
  });

  it("absent review block → undefined (review off after resolve)", () => {
    const c = normaliseRawConfigForTest({ version: 1 });
    assert.equal(c.review, undefined);
    assert.equal(resolveReviewConfig(c.review).enabled, false);
  });
});

describe("review.ghToken (pinned token)", () => {
  it("carries a literal ghToken through the parser + resolves it", () => {
    const c = normaliseRawConfigForTest({
      version: 1,
      review: { enabled: true, ghToken: "gho_literaltoken" },
    });
    assert.equal(c.review?.ghToken, "gho_literaltoken");
    assert.equal(resolveReviewGhToken(c.review), "gho_literaltoken");
  });
  it("carries a {cmd} secret-reference through the parser (unresolved)", () => {
    const c = normaliseRawConfigForTest({
      version: 1,
      review: { enabled: true, ghToken: { cmd: "gh auth token --user X" } },
    });
    assert.deepEqual(c.review?.ghToken, { cmd: "gh auth token --user X" });
  });
  it("resolveReviewGhToken returns undefined when unset", () => {
    assert.equal(resolveReviewGhToken({ enabled: true }), undefined);
    assert.equal(resolveReviewGhToken(undefined), undefined);
  });
});
