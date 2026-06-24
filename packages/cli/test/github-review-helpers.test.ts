// packages/cli/test/github-review-helpers.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildGhArgs_getPrHead, buildGhArgs_getAuthUser } from "../src/adapters/github";

describe("github review helper argv", () => {
  it("getAuthUser argv", () => {
    assert.deepEqual(buildGhArgs_getAuthUser(), ["api", "user", "--jq", ".login"]);
  });
  it("getPrHead argv", () => {
    assert.deepEqual(buildGhArgs_getPrHead("o/r", 12), [
      "api", "repos/o/r/pulls/12", "--jq", "{sha:.head.sha,base:.base.ref}",
    ]);
  });
});
