import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Never point HOME back at the operator's home. Test files run in separate
// processes, so restoring buys nothing — and it opens a window that has
// already caused an outage: a cancelled test's abandoned continuation resumes
// AFTER afterEach, sees the real HOME, and writes to the live ~/.pmk. On
// 2026-08-04 that overwrote the gateway config with test fixtures and took
// the bot down. ORIG_HOME is a throwaway directory, never the real one.
const ORIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-safe-home-"));
process.env.HOME = ORIG_HOME;

describe("AnthropicApiKeyProvider token.usage emission (T5 / v0.12.0)", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-anthropic-test-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env.HOME = ORIG_HOME;
  });

  it("emits token.usage event after stream completes (when actor is provided)", async () => {
    const { AnthropicApiKeyProvider } = await import(
      "../src/llm/anthropic-api"
    );
    const { readGatewayEvents } = await import("../src/gateway/events");

    const provider = new AnthropicApiKeyProvider({
      provider: "anthropic-api",
      model: "claude-sonnet-4-6",
      maxTokens: 4096,
      apiKey: "sk-ant-test",
    } as never);

    const fakeStream = {
      [Symbol.asyncIterator]: async function* () {
        yield {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "hello" },
        };
      },
      finalMessage: async () => ({
        usage: {
          input_tokens: 1234,
          output_tokens: 56,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 0,
        },
      }),
    };
    (provider as unknown as { client: unknown }).client = {
      messages: { stream: async () => fakeStream },
    };

    const result = await provider.chat(
      "sys",
      [{ role: "user", content: "hi" }],
      { actor: "Uabc" },
    );
    assert.equal(result, "hello");

    const events = readGatewayEvents({});
    const usage = events.find((e) => e.type === "token.usage");
    assert.ok(usage, "expected token.usage event");
    if (usage && usage.type === "token.usage") {
      assert.equal(usage.actor, "Uabc");
      assert.equal(usage.provider, "anthropic-api");
      assert.equal(usage.model, "claude-sonnet-4-6");
      assert.equal(usage.inputTokens, 1234);
      assert.equal(usage.outputTokens, 56);
      assert.equal(usage.cacheReadTokens, 100);
      assert.equal(usage.cacheCreationTokens, 0);
    }
  });

  it("does NOT emit token.usage when actor is undefined", async () => {
    const { AnthropicApiKeyProvider } = await import(
      "../src/llm/anthropic-api"
    );
    const { readGatewayEvents } = await import("../src/gateway/events");

    const provider = new AnthropicApiKeyProvider({
      provider: "anthropic-api",
      model: "claude-sonnet-4-6",
      maxTokens: 4096,
      apiKey: "sk-ant-test",
    } as never);

    const fakeStream = {
      [Symbol.asyncIterator]: async function* () {
        yield {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "ok" },
        };
      },
      finalMessage: async () => ({
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    };
    (provider as unknown as { client: unknown }).client = {
      messages: { stream: async () => fakeStream },
    };

    await provider.chat("sys", [{ role: "user", content: "hi" }]);

    const events = readGatewayEvents({});
    assert.equal(
      events.filter((e) => e.type === "token.usage").length,
      0,
      "no token.usage event when actor missing",
    );
  });
});
