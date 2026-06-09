import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import type { MessageCappedEvent } from "../src/gateway/events";

describe("MessageCappedEvent kind", () => {
  it("accepts 'attachment'", () => {
    const e: MessageCappedEvent = {
      type: "message.capped", actor: "U1", kind: "attachment",
      originalChars: 100, cappedChars: 30,
    };
    assert.equal(e.kind, "attachment");
  });
});
