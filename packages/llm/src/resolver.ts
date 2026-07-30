import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LlmProviderName, PmkConfig } from "@pmk/shared";
import { AnthropicApiKeyProvider } from "./anthropic-api";
import { ClaudeAgentSdkProvider } from "./claude-agent";
import {
  NoProviderAvailableError,
  type LlmProvider,
  type TokenUsageReporter,
} from "./provider";

export interface ResolveProviderOptions {
  onUsage?: TokenUsageReporter;
}

export function resolveProvider(
  config: PmkConfig,
  opts: ResolveProviderOptions = {},
): LlmProvider {
  const requested =
    (process.env.PMK_PROVIDER as LlmProviderName | undefined) ??
    config.provider ??
    "auto";

  if (requested === "auto") return autoResolve(config, opts);
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
    return new AnthropicApiKeyProvider(
      { ...config, apiKey: config.apiKey },
      opts.onUsage,
    );
  }
  throw new Error(`[pmk] unknown provider: ${requested}`);
}

function autoResolve(
  config: PmkConfig,
  opts: ResolveProviderOptions,
): LlmProvider {
  if (config.apiKey) {
    return new AnthropicApiKeyProvider(
      { ...config, apiKey: config.apiKey },
      opts.onUsage,
    );
  }
  const claudePath = findClaudeExecutable();
  if (claudePath) return new ClaudeAgentSdkProvider(config, claudePath);
  throw new NoProviderAvailableError(["anthropic-api", "claude-agent"]);
}

export function resolveProviderOrExit(config: PmkConfig): LlmProvider {
  try {
    return resolveProvider(config);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

export function findClaudeExecutable(): string | undefined {
  if (process.env.PMK_SKIP_CLAUDE_PROBE === "1") return undefined;
  const cmd = process.platform === "win32" ? "where claude" : "which claude";
  try {
    const out = execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const first = out.split(/\r?\n/)[0];
    if (first) return first;
  } catch {
    // Fall through to well-known install paths.
  }
  return findClaudeOnDisk();
}

function findClaudeOnDisk(): string | undefined {
  if (process.platform === "win32") {
    return [
      path.join(process.env.USERPROFILE ?? "", ".claude", "bin", "claude.exe"),
      path.join(process.env.USERPROFILE ?? "", "scoop", "shims", "claude.exe"),
    ].find(isExecutable);
  }
  const home = os.homedir();
  return [
    path.join(home, ".local", "bin", "claude"),
    path.join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ].find(isExecutable);
}

function isExecutable(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}
