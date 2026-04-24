import { execSync } from "node:child_process";
import type { LlmProviderName, PmkConfig } from "@pmk/shared";
import { AnthropicApiKeyProvider } from "./anthropic-api";
import { ClaudeAgentSdkProvider } from "./claude-agent";
import { NoProviderAvailableError, type LlmProvider } from "./provider";

/**
 * Find a usable LLM provider.
 *
 * Order (`config.provider: "auto"`):
 *   1. local `claude` binary on PATH → ClaudeAgentSdkProvider
 *   2. ANTHROPIC_API_KEY (or config.apiKey) → AnthropicApiKeyProvider
 *   3. fail with actionable error
 *
 * `PMK_PROVIDER` env var overrides `config.provider`.
 */
export function resolveProvider(config: PmkConfig): LlmProvider {
  const requested =
    (process.env.PMK_PROVIDER as LlmProviderName | undefined) ??
    config.provider ??
    "auto";

  if (requested === "auto") {
    return autoResolve(config);
  }
  if (requested === "claude-agent") {
    const claudePath = findClaudeExecutable();
    if (!claudePath) {
      throw new Error(
        "[pmk] provider 'claude-agent' requested, but `claude` is not on PATH. Install Claude Code first.",
      );
    }
    return new ClaudeAgentSdkProvider(config, claudePath);
  }
  if (requested === "anthropic-api") {
    if (!config.apiKey) {
      throw new Error(
        "[pmk] provider 'anthropic-api' requested, but ANTHROPIC_API_KEY is not set.",
      );
    }
    return new AnthropicApiKeyProvider({ ...config, apiKey: config.apiKey });
  }
  throw new Error(`[pmk] unknown provider: ${requested}`);
}

function autoResolve(config: PmkConfig): LlmProvider {
  const claudePath = findClaudeExecutable();
  if (claudePath) {
    return new ClaudeAgentSdkProvider(config, claudePath);
  }
  if (config.apiKey) {
    return new AnthropicApiKeyProvider({ ...config, apiKey: config.apiKey });
  }
  throw new NoProviderAvailableError(["claude-agent", "anthropic-api"]);
}

/**
 * Caller-friendly wrapper: print the error and exit(1) instead of throwing.
 * Commands use this so users see one clean message, not a stack trace.
 */
export function resolveProviderOrExit(config: PmkConfig): LlmProvider {
  try {
    return resolveProvider(config);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

/**
 * Exported for tests. Uses `which` (POSIX) or `where` (Windows).
 * Returns absolute path, or undefined if not found.
 */
export function findClaudeExecutable(): string | undefined {
  const cmd = process.platform === "win32" ? "where claude" : "which claude";
  try {
    const out = execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const first = out.split(/\r?\n/)[0];
    return first || undefined;
  } catch {
    return undefined;
  }
}
