import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { extractText } from "../src/gateway/attachments/extractors/text";

describe("extractText", () => {
  it("reads UTF-8 text", async () => {
    const body = "# Heading\nThis markdown body is comfortably over twenty characters.";
    const r = await extractText(Buffer.from(body, "utf8"));
    assert.deepEqual(r, { ok: true, text: body });
  });
  it("rejects binary (NUL byte)", async () => {
    const r = await extractText(Buffer.from([0x41, 0x00, 0x42]));
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /binary/i);
  });
  it("rejects whitespace-only as empty content", async () => {
    const r = await extractText(Buffer.from("   \n\t  ", "utf8"));
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /empty/i);
  });
  it("caps to FILE_EXTRACT_CAP with a marker", async () => {
    const r = await extractText(Buffer.from("x".repeat(40_000), "utf8"));
    assert.equal(r.ok, true);
    assert.ok((r as { text: string }).text.length <= 30_100);
    assert.match((r as { text: string }).text, /truncated/);
  });
});
