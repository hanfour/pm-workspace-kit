import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { extractImage } from "../src/gateway/attachments/extractors/image";
import type { LlmProvider } from "../src/llm/provider";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // tiny stand-in

function llmWith(describe?: LlmProvider["describeImage"]): LlmProvider {
  return {
    name: "anthropic-api",
    displayName: "test",
    chat: async () => "",
    describeImage: describe,
  };
}

describe("extractImage", () => {
  it("calls describeImage and returns the description", async () => {
    const llm = llmWith(async (img) => `desc:${img.mimetype}:${img.data.length}b`);
    const r = await extractImage(png, "image/png", { llm });
    assert.deepEqual(r, { ok: true, text: "desc:image/png:4b" });
  });
  it("is unsupported when the provider lacks describeImage", async () => {
    const r = await extractImage(png, "image/png", { llm: llmWith(undefined) });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /ANTHROPIC_API_KEY/);
  });
  it("rejects an image over MAX_IMAGE_BYTES (decoded)", async () => {
    const big = Buffer.alloc(6 * 1024 * 1024);
    const r = await extractImage(big, "image/png", { llm: llmWith(async () => "x") });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /too large/i);
  });

  it("Fix 4: rejects an image whose base64-encoded size exceeds 5MB even if decoded size does not", async () => {
    // 3_932_161 decoded bytes → Math.ceil(3_932_161/3)*4 = 5_242_884 base64 bytes,
    // which is 4 bytes over the 5_242_880-byte (5 MB) limit.
    // Under the old decoded-byte guard this would pass; under the fixed
    // base64-encoded guard it must be rejected.
    const decodedBytes = 3_932_161;
    const borderBuf = Buffer.alloc(decodedBytes);
    const base64Size = Math.ceil(decodedBytes / 3) * 4;
    const MAX = 5 * 1024 * 1024; // 5_242_880
    // Sanity assertions (these are constants, not runtime assertions)
    assert.ok(decodedBytes < MAX, "decoded size should be under 5MB");
    assert.ok(base64Size > MAX, "base64 size should exceed 5MB");

    const r = await extractImage(borderBuf, "image/png", { llm: llmWith(async () => "x") });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /too large/i);
  });
});
