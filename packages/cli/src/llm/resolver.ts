import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LlmProviderName, PmkConfig } from "@pmk/shared";
import { AnthropicApiKeyProvider } from "./anthropic-api";
import { ClaudeAgentSdkProvider } from "./claude-agent";
import { NoProviderAvailableError, type LlmProvider } from "./provider";

/**
 * Find a usable LLM provider.
 *
 * Order (`config.provider: "auto"`, v0.12.0+):
 *   1. ANTHROPIC_API_KEY (or config.apiKey) → AnthropicApiKeyProvider
 *   2. local `claude` binary on PATH → ClaudeAgentSdkProvider (fallback)
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
  // v0.12.0: prefer anthropic-api when apiKey is available — eliminates
  // claude-agent-sdk host-context overhead. Falls through to claude-agent
  // for users without an API key (zero-touch upgrade for that branch).
  if (config.apiKey) {
    return new AnthropicApiKeyProvider({ ...config, apiKey: config.apiKey });
  }
  const claudePath = findClaudeExecutable();
  if (claudePath) {
    return new ClaudeAgentSdkProvider(config, claudePath);
  }
  throw new NoProviderAvailableError(["anthropic-api", "claude-agent"]);
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
 * Exported for tests.
 *
 * Two-layer lookup so we find `claude` in GUI-app contexts (Electron
 * DMG launch, Finder) where PATH is a skeletal Launchd-minimum that
 * excludes user-local bin dirs:
 *
 *   1. `which claude` (POSIX) / `where claude` (Windows) — wins when
 *      PATH is configured correctly (terminal-launched processes).
 *   2. Filesystem probe of well-known install locations.
 */
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
    /* fall through */
  }
  return findClaudeOnDisk();
}

function findClaudeOnDisk(): string | undefined {
  if (process.platform === "win32") {
    // Narrow probes on Windows — user may install via npm or scoop.
    const candidates = [
      path.join(process.env.USERPROFILE ?? "", ".claude", "bin", "claude.exe"),
      path.join(process.env.USERPROFILE ?? "", "scoop", "shims", "claude.exe"),
    ];
    return candidates.find(isExecutable);
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, ".local", "bin", "claude"),
    path.join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
  return candidates.find(isExecutable);
}

function isExecutable(p: string): boolean {
  try {
    if (!existsSync(p)) return false;
    const s = statSync(p);
    return s.isFile();
  } catch {
    return false;
  }
}
