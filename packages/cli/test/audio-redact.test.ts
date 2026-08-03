import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { redactSecrets, countHighEntropyTokens } from "../src/gateway/redact";

describe("redactSecrets broadened", () => {
  it("redacts cloud/service creds, emails, separator-delimited phones", () => {
    const r = redactSecrets("k=AKIAIOSFODNN7EXAMPLE gh=ghp_abcdefghijklmnopqrstuvwxyz0123 g=AIzaSyA1234567890123456789012345678901234 m=alice@acme.com t=+1 415-555-1212");
    for (const leak of ["AKIA", "ghp_", "AIzaSy", "alice@acme.com", "415-555-1212"]) assert.ok(!r.includes(leak), leak);
  });
  it("does NOT redact bare numeric IDs (no separator/plus)", () => {
    assert.equal(redactSecrets("revenue 12345678"), "revenue 12345678");
  });
  it("redacts a GitLab personal access token (glpat-)", () => {
    const r = redactSecrets("token glpat-abcdef1234567890ABCDEF");
    assert.ok(!r.includes("glpat-abcdef1234567890ABCDEF"));
    assert.ok(r.includes("[gitlab-token]"));
  });
  it("counts high-entropy tokens (possible secrets)", () => {
    assert.ok(countHighEntropyTokens("xQ7zP2bN8kL4mW9rT6yU3vC1sD5fG0hJ4kL") >= 1);
    assert.equal(countHighEntropyTokens("the quarterly roadmap review"), 0);
  });
  it("counts a base64 token that carries = / == padding as one token", () => {
    assert.equal(countHighEntropyTokens("dGhpcyBpcyBhIGxvbmcgc2VjcmV0IHZhbHVl=="), 1);
    assert.equal(countHighEntropyTokens("YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXphYmM="), 1);
    // two padded tokens in one string are counted separately
    assert.equal(countHighEntropyTokens(`${"A".repeat(34)}== ${"B".repeat(34)}=`), 2);
  });
});

describe("phone redaction precision", () => {
  it("redacts real phone numbers (international + domestic 0-prefixed / parenthesised)", () => {
    for (const s of ["+1 415-555-1212", "0912-345-678", "02-1234-5678", "(02) 1234 5678", "0800 123 456"]) {
      assert.ok(redactSecrets(`call ${s}`).includes("[phone]"), s);
    }
  });
  it("does NOT over-redact 3-group numeric IDs / amounts / refs", () => {
    for (const s of ["order 1234 5678 9012", "ID 100-2000-3000", "amount 10 200 3000", "ticket 4899 1234 5678", "date 2026-07-14"]) {
      assert.equal(redactSecrets(s), s, s);
    }
  });
});
