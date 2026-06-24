import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { normaliseRawConfigForTest, resolveGithubToken } from "../src/gateway/config";

describe("github config", () => {
  it("normalises a literal token + allowPublicRepos", () => {
    const c = normaliseRawConfigForTest({
      version: 1,
      github: { token: "ghp_literal", allowPublicRepos: true },
    });
    assert.deepEqual(c.github, { token: "ghp_literal", allowPublicRepos: true });
  });
  it("normalises a {cmd} reference and defaults allowPublicRepos to undefined", () => {
    const c = normaliseRawConfigForTest({
      version: 1,
      github: { token: { cmd: "op read op://v/gh" } },
    });
    assert.deepEqual(c.github?.token, { cmd: "op read op://v/gh" });
    assert.equal(c.github?.allowPublicRepos, undefined);
  });
  it("resolveGithubToken returns a literal, undefined when unset", () => {
    assert.equal(resolveGithubToken({ token: "ghp_x" }), "ghp_x");
    assert.equal(resolveGithubToken(undefined), undefined);
  });
});
