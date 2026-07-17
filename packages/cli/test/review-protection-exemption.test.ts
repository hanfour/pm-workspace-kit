// packages/cli/test/review-protection-exemption.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findProtectionExemption } from "../src/gateway/review-policy";
import type { ApprovalConfig } from "../src/gateway/config";

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

    // Exact match is case-sensitive. GitHub repo slugs ARE case-insensitive,
    // so someone will eventually propose relaxing this to a case-fold
    // compare — pin it here so the tests are the thing that stops them.
    // (Also consistent with the sibling `repoAllowlist`, which is checked
    // via plain `Array.includes`.)
    assert.equal(findProtectionExemption(approval, "ONEAD/OSS-UI-V2"), undefined);
    assert.equal(findProtectionExemption(approval, "onead/OSS-UI-V2"), undefined);

    // Exact match does not unicode-normalise either: an NFD-decomposed
    // slug (base letter + combining accent as separate code points) must
    // not match a stored NFC (precomposed) repo name, even though the two
    // render identically and `String.normalize()` would consider them equal.
    const nfcRepo = "onead/caf\u00e9"; // "café", NFC — precomposed é (U+00E9)
    const nfdSlug = "onead/cafe\u0301"; // "café", NFD — e + combining acute (U+0301)
    const unicode = { enabled: true, protectionExemptions: [{ repo: nfcRepo, reason: "unicode pin" }] };
    assert.equal(findProtectionExemption(unicode, nfdSlug), undefined);
  });

  it("tolerates an approval block with no exemptions at all", () => {
    // Type annotation, not a cast: `{ enabled: true }` already satisfies
    // ApprovalConfig with no cast needed (protectionExemptions is optional).
    // An annotation also catches a future required-field change on
    // ApprovalConfig — a cast would silently paper over that instead.
    const noExemptionsField: ApprovalConfig = { enabled: true };
    const emptyExemptions = { enabled: true, protectionExemptions: [] };
    assert.equal(findProtectionExemption(noExemptionsField, "onead/oss-ui-v2"), undefined);
    assert.equal(findProtectionExemption(emptyExemptions, "onead/oss-ui-v2"), undefined);
  });
});
