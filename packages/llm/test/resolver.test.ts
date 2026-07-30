import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { DEFAULT_CONFIG, type PmkConfig } from "@pmk/shared";
import { NoProviderAvailableError, resolveProvider } from "../src";

const ORIG_PATH = process.env.PATH;
const ORIG_API_KEY = process.env.ANTHROPIC_API_KEY;
const ORIG_PROVIDER = process.env.PMK_PROVIDER;

function baseConfig(overrides: Partial<PmkConfig> = {}): PmkConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

describe("resolveProvider (auto)", () => {
  beforeEach(() => {
    // Force `which claude` lookups AND the filesystem fallback to fail.
    process.env.PATH = "/nonexistent-dir";
    process.env.PMK_SKIP_CLAUDE_PROBE = "1";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PMK_PROVIDER;
  });
  afterEach(() => {
    process.env.PATH = ORIG_PATH;
    if (ORIG_API_KEY !== undefined)
      process.env.ANTHROPIC_API_KEY = ORIG_API_KEY;
    if (ORIG_PROVIDER !== undefined) process.env.PMK_PROVIDER = ORIG_PROVIDER;
  });

  it("throws NoProviderAvailableError when neither claude nor API key is available", () => {
    assert.throws(
      () => resolveProvider(baseConfig({ provider: "auto" })),
      NoProviderAvailableError,
    );
  });

  it("falls back to anthropic-api when API key present but no claude binary", () => {
    const p = resolveProvider(
      baseConfig({ provider: "auto", apiKey: "sk-test-123" }),
    );
    assert.equal(p.name, "anthropic-api");
  });
});

describe("resolveProvider (explicit provider)", () => {
  beforeEach(() => {
    process.env.PATH = "/nonexistent-dir";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PMK_PROVIDER;
  });
  afterEach(() => {
    process.env.PATH = ORIG_PATH;
    if (ORIG_API_KEY !== undefined)
      process.env.ANTHROPIC_API_KEY = ORIG_API_KEY;
    if (ORIG_PROVIDER !== undefined) process.env.PMK_PROVIDER = ORIG_PROVIDER;
  });

  it("errors when provider=claude-agent but no claude binary", () => {
    assert.throws(
      () => resolveProvider(baseConfig({ provider: "claude-agent" })),
      /claude-agent.*not on PATH/,
    );
  });

  it("errors when provider=anthropic-api but no API key", () => {
    assert.throws(
      () => resolveProvider(baseConfig({ provider: "anthropic-api" })),
      /ANTHROPIC_API_KEY is not set/,
    );
  });

  it("PMK_PROVIDER env overrides config.provider", () => {
    process.env.PMK_PROVIDER = "anthropic-api";
    // config says auto, env says anthropic-api; API key missing → should error with anthropic-api path.
    assert.throws(
      () => resolveProvider(baseConfig({ provider: "auto" })),
      /ANTHROPIC_API_KEY is not set/,
    );
  });
});

describe("resolveProvider autoResolve order (v0.12.0)", () => {
  beforeEach(() => {
    delete process.env.PMK_PROVIDER;
    process.env.PMK_SKIP_CLAUDE_PROBE = "1"; // disable filesystem probe in tests
  });
  afterEach(() => {
    if (ORIG_PROVIDER !== undefined) process.env.PMK_PROVIDER = ORIG_PROVIDER;
    else delete process.env.PMK_PROVIDER;
    delete process.env.PMK_SKIP_CLAUDE_PROBE;
  });

  it("apiKey present → anthropic-api (preferred over claude-agent)", () => {
    const provider = resolveProvider(
      baseConfig({ provider: "auto", apiKey: "sk-ant-xxx" }),
    );
    assert.equal(provider.name, "anthropic-api");
  });

  it("apiKey absent + no claude binary → throws NoProviderAvailableError", () => {
    assert.throws(
      () => resolveProvider(baseConfig({ provider: "auto", apiKey: undefined })),
      /no usable LLM provider/,
    );
  });
});
