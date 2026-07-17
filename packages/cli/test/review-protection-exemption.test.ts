// packages/cli/test/review-protection-exemption.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findProtectionExemption } from "../src/gateway/review-policy";
import type { ProtectionExemption } from "../src/gateway/config";

const approval = {
  enabled: true,
  protectionExemptions: [
    { repo: "onead/oss-ui-v2", reason: "ruleset 8015695 pending" },
    { repo: "onead/other", reason: "second entry" },
  ],
};

describe("findProtectionExemption", () => {
  it("returns the matching entry with its reason", () => {
    const found = findProtectionExemption(approval, "onead/oss-ui-v2");
    assert.equal(found?.repo, "onead/oss-ui-v2");
    assert.equal(found?.reason, "ruleset 8015695 pending");
  });

  it("returns undefined for a repo that is not listed", () => {
    assert.equal(findProtectionExemption(approval, "onead/unlisted"), undefined);
  });

  it("never matches by wildcard or prefix — the blast radius stays exact", () => {
    assert.equal(findProtectionExemption(approval, "onead/*"), undefined);
    assert.equal(findProtectionExemption(approval, "onead/oss-ui-v2-fork"), undefined);
    assert.equal(findProtectionExemption(approval, "onead"), undefined);
    const wild = { enabled: true, protectionExemptions: [{ repo: "onead/*", reason: "nope" }] };
    assert.equal(findProtectionExemption(wild, "onead/oss-ui-v2"), undefined);
  });

  it("tolerates an approval block with no exemptions at all", () => {
    // Cast, not a fresh literal call arg: TS's weak-type check would
    // otherwise reject `{ enabled: true }` outright since it shares no
    // property with the (all-optional) parameter type — the cast asserts
    // this is deliberately an approval block missing the field entirely.
    const noExemptionsField = { enabled: true } as { protectionExemptions?: ProtectionExemption[] };
    const emptyExemptions = { enabled: true, protectionExemptions: [] };
    assert.equal(findProtectionExemption(noExemptionsField, "onead/oss-ui-v2"), undefined);
    assert.equal(findProtectionExemption(emptyExemptions, "onead/oss-ui-v2"), undefined);
  });
});
