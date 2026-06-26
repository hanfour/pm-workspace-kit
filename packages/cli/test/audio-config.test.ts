import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { resolveAudioConfig, resolveOpenAiKey } from "../src/gateway/config";

describe("resolveAudioConfig", () => {
  it("applies defaults (disabled, gpt-4o-mini-transcribe, zh, quotas)", () => {
    const c = resolveAudioConfig(undefined);
    assert.equal(c.enabled, false);
    assert.equal(c.model, "gpt-4o-mini-transcribe");
    assert.equal(c.language, "zh");
    assert.equal(c.maxDurationSec, 7200);
    assert.equal(c.perUserDailyMinutes, 120);
    assert.equal(c.globalDailyMinutes, 600);
  });
  it("honours overrides", () => {
    const c = resolveAudioConfig({ enabled: true, model: "whisper-1", quota: { perUserDailyMinutes: 30 } });
    assert.equal(c.enabled, true);
    assert.equal(c.model, "whisper-1");
    assert.equal(c.perUserDailyMinutes, 30);
  });
});

describe("resolveOpenAiKey", () => {
  const ORIG = process.env.OPENAI_API_KEY;
  afterEach(() => { if (ORIG === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = ORIG; });
  it("resolves {env} reference", () => {
    process.env.OPENAI_API_KEY = "sk-test-123";
    assert.equal(resolveOpenAiKey({ openaiApiKey: { env: "OPENAI_API_KEY" } }), "sk-test-123");
  });
  it("treats a bare string as a literal (back-compat, not a reference)", () => {
    assert.equal(resolveOpenAiKey({ openaiApiKey: "sk-literal" }), "sk-literal");
  });
  it("returns undefined when unset", () => {
    assert.equal(resolveOpenAiKey({}), undefined);
  });
});
