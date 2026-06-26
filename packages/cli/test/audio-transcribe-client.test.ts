import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { transcribeFile, TranscribeError } from "../src/gateway/audio/transcribe-client";

const okResp = () => new Response(JSON.stringify({ text: "你好 世界" }), { status: 200 });
const errResp = (status: number) => new Response(JSON.stringify({ error: { message: "boom" } }), { status });

const baseDeps = (fetchImpl: typeof fetch) => ({ fetchImpl, readStream: (_p: string) => Buffer.from("AUDIO") });

describe("transcribeFile", () => {
  it("returns text on 200", async () => {
    const t = await transcribeFile("/tmp/c.ogg", { apiKey: "sk-x", model: "gpt-4o-mini-transcribe", language: "zh" },
      baseDeps((async () => okResp()) as never));
    assert.equal(t, "你好 世界");
  });
  it("maps 429 to a retryable TranscribeError with status", async () => {
    await assert.rejects(
      () => transcribeFile("/tmp/c.ogg", { apiKey: "sk-x", model: "m" }, baseDeps((async () => errResp(429)) as never)),
      (e: unknown) => e instanceof TranscribeError && e.status === 429,
    );
  });
  it("never leaks the api key in the error message", async () => {
    const err = await transcribeFile("/tmp/c.ogg", { apiKey: "sk-proj-SECRET", model: "m" }, baseDeps((async () => errResp(401)) as never))
      .catch((e: unknown) => e);
    assert.ok(err instanceof Error, "expected a rejection");
    assert.ok(!(err as Error).message.includes("sk-proj-SECRET"));
  });
  it("maps 5xx to a TranscribeError with status", async () => {
    await assert.rejects(
      () => transcribeFile("/tmp/c.ogg", { apiKey: "sk-x", model: "m" }, baseDeps((async () => errResp(500)) as never)),
      (e: unknown) => e instanceof TranscribeError && e.status === 500,
    );
  });
});
