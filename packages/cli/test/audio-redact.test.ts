import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { redactSecrets, countHighEntropyTokens } from "../src/gateway/audio/redact";

describe("redactSecrets broadened", () => {
  it("redacts cloud/service creds, emails, separator-delimited phones", () => {
    const r = redactSecrets("k=AKIAIOSFODNN7EXAMPLE gh=ghp_abcdefghijklmnopqrstuvwxyz0123 g=AIzaSyA1234567890123456789012345678901234 m=alice@acme.com t=+1 415-555-1212");
    for (const leak of ["AKIA", "ghp_", "AIzaSy", "alice@acme.com", "415-555-1212"]) assert.ok(!r.includes(leak), leak);
  });
  it("does NOT redact bare numeric IDs (no separator/plus)", () => {
    assert.equal(redactSecrets("revenue 12345678"), "revenue 12345678");
  });
  it("counts high-entropy tokens (possible secrets)", () => {
    assert.ok(countHighEntropyTokens("xQ7zP2bN8kL4mW9rT6yU3vC1sD5fG0hJ4kL") >= 1);
    assert.equal(countHighEntropyTokens("the quarterly roadmap review"), 0);
  });
});
