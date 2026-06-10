import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  PmkContextTooLongError,
  isContextTooLongError,
  buildImageUserMessage,
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

describe("buildImageUserMessage", () => {
  it("builds a user SDK message with a base64 image block then the text", () => {
    const msg = buildImageUserMessage(
      { data: Buffer.from([1, 2, 3]), mimetype: "image/png" },
      "describe this",
    );
    assert.equal(msg.type, "user");
    assert.equal(msg.parent_tool_use_id, null);
    assert.equal(msg.message.role, "user");
    const content = msg.message.content as unknown as Array<
      Record<string, unknown>
    >;
    assert.equal(content[0].type, "image");
    const source = content[0].source as Record<string, unknown>;
    assert.equal(source.type, "base64");
    assert.equal(source.media_type, "image/png");
    assert.equal(source.data, Buffer.from([1, 2, 3]).toString("base64"));
    assert.equal(content[1].type, "text");
    assert.equal(content[1].text, "describe this");
  });
});
