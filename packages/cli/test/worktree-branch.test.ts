import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { assertSafeBranch } from "../src/commands/worktree";

describe("assertSafeBranch", () => {
  it("accepts common branch name shapes", () => {
    assert.doesNotThrow(() => assertSafeBranch("main"));
    assert.doesNotThrow(() => assertSafeBranch("feat/desktop-app"));
    assert.doesNotThrow(() => assertSafeBranch("release/v1.2.3"));
    assert.doesNotThrow(() => assertSafeBranch("user_foo-bar"));
    assert.doesNotThrow(() => assertSafeBranch("a.b/c"));
  });

  it("rejects empty / overly long names", () => {
    assert.throws(() => assertSafeBranch(""), /invalid/);
    assert.throws(() => assertSafeBranch("x".repeat(200)), /invalid/);
  });

  it("rejects names starting with '-' (would look like a git flag)", () => {
    assert.throws(() => assertSafeBranch("-oops"), /cannot start with '-'/);
    assert.throws(() => assertSafeBranch("--force"), /cannot start with '-'/);
  });

  it("rejects '..' segments", () => {
    assert.throws(
      () => assertSafeBranch("feat/..hack"),
      /forbidden characters/,
    );
    assert.throws(() => assertSafeBranch(".."), /forbidden characters/);
  });

  it("rejects whitespace + control chars", () => {
    assert.throws(() => assertSafeBranch("foo bar"), /forbidden characters/);
    assert.throws(() => assertSafeBranch("foo\tbar"), /forbidden characters/);
    assert.throws(() => assertSafeBranch("foo\x01bar"), /forbidden characters/);
  });

  it("rejects shell / git special characters", () => {
    // `foo;rm -rf /` hits the whitespace guard first (space before rm);
    // the others trip the character-whitelist.
    assert.throws(
      () => assertSafeBranch("foo;rm -rf /"),
      /forbidden|must match/,
    );
    assert.throws(() => assertSafeBranch("foo$bar"), /must match/);
    assert.throws(() => assertSafeBranch("foo'bar"), /must match/);
    assert.throws(() => assertSafeBranch("foo;bar"), /must match/);
  });
});
