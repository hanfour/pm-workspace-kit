import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  PmkContextTooLongError,
  isContextTooLongError,
} from "../src/llm/claude-agent";

describe("PmkContextTooLongError detection", () => {
  it("matches msg_too_long error message", () => {
    assert.equal(
      isContextTooLongError(new Error("An API error occurred: msg_too_long")),
      true,
    );
  });
  it("matches 'prompt is too long'", () => {
    assert.equal(
      isContextTooLongError(new Error("prompt is too long for the model")),
      true,
    );
  });
  it("matches 'context window exceeded'", () => {
    assert.equal(
      isContextTooLongError(new Error("context window exceeded")),
      true,
    );
  });
  it("does not match unrelated errors", () => {
    assert.equal(isContextTooLongError(new Error("rate limit hit")), false);
  });
  it("preserves cause", () => {
    const cause = new Error("msg_too_long");
    const err = new PmkContextTooLongError(cause);
    assert.equal(err.cause, cause);
    assert.ok(err instanceof Error);
  });
});
