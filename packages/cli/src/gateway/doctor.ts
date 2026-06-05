// Doctor — pre-flight check orchestrator for `pmk gateway doctor`.
//
// FR2 of PRD-2026-0006. Each check is a pure async function that takes
// a `DoctorContext` and returns a `DoctorCheckResult`. Real I/O happens
// via injectable runners (slack auth, anthropic echo, mra list) so the
// checks themselves stay testable without network access.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebClient } from "@slack/web-api";

import {
  type GatewayConfig,
  gatewayConfigPath,
  loadGatewayConfig,
  loadRawGatewayConfig,
  normaliseRawConfigForTest,
} from "./config";
import { approvedAtomCount } from "./atom-index";
import { loadConfig } from "../config";
import { findClaudeExecutable } from "../llm/resolver";
import { type SecretSource } from "./secret-source";

export type DoctorSeverity = "pass" | "warn" | "fail";

export interface DoctorCheckResult {
  name: string;
  severity: DoctorSeverity;
  message: string;
  hint?: string;
}

export interface DoctorRunners {
  slackAppAuth: (
    token: string,
  ) => Promise<{ ok: boolean; teamId?: string; error?: string }>;
  slackBotAuth: (
    token: string,
  ) => Promise<{
    ok: boolean;
    team?: string;
    user?: string;
    botId?: string;
    error?: string;
  }>;
  anthropicEcho: (
    apiKey: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  mraList: (
    workspace: string,
  ) => Promise<{ ok: boolean; repos: string[]; error?: string }>;
  // Count of approved atoms already on disk. Read-only — lets the
  // pkb-content check distinguish a populated PKB from a configured-
  // but-empty one without running ingest.
  atomCount: (scope?: string) => Promise<number>;
  // Whether the local `claude` CLI is on PATH. The runtime falls back
  // to it (claude-agent SDK / OAuth) when no API key is set, so the
  // llm-provider check must know about it to avoid a false FAIL.
  claudeCli: () => Promise<{ available: boolean; path?: string }>;
}

export interface DoctorContext {
  home: string;
  configPath: string;
  config: GatewayConfig | null;
  configFileStat: { exists: boolean; mode?: number };
  envAnthropicKey?: string;
  // Effective LLM provider, resolved the same way the runtime does:
  // PMK_PROVIDER env → CLI config.provider → "auto".
  llmProvider: string;
  manifestRepoPath: string;
  runners: DoctorRunners;
  /** Raw on-disk secret sources (for source reporting — never resolved here). */
  secretSources: {
    appToken?: SecretSource;
    botToken?: SecretSource;
    apiKey?: SecretSource;
  };
  /** CLI-config apiKey (= ANTHROPIC_API_KEY ?? ~/.pmk/config.json), for apiKey shadowing. */
  cliApiKey?: string;
}

export type DoctorCheck = (ctx: DoctorContext) => Promise<DoctorCheckResult>;

export interface DoctorReport {
  results: DoctorCheckResult[];
  failed: number;
  warned: number;
  passed: number;
}

export async function runDoctor(
  ctx: DoctorContext,
  checks: DoctorCheck[],
): Promise<DoctorReport> {
  const results: DoctorCheckResult[] = [];
  for (const check of checks) {
    try {
      results.push(await check(ctx));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        name: check.name || "unknown",
        severity: "fail",
        message: `check threw: ${message}`,
      });
    }
  }
  return {
    results,
    failed: results.filter((r) => r.severity === "fail").length,
    warned: results.filter((r) => r.severity === "warn").length,
    passed: results.filter((r) => r.severity === "pass").length,
  };
}

export function formatDoctorReport(
  report: DoctorReport,
  opts: { json?: boolean } = {},
): string {
  if (opts.json) {
    return JSON.stringify(report, null, 2);
  }
  const lines: string[] = [];
  // Stable ordering: FAIL first (so they're noticed), then WARN, then PASS.
  const ordered = [
    ...report.results.filter((r) => r.severity === "fail"),
    ...report.results.filter((r) => r.severity === "warn"),
    ...report.results.filter((r) => r.severity === "pass"),
  ];
  for (const r of ordered) {
    const tag =
      r.severity === "fail"
        ? "[FAIL]"
        : r.severity === "warn"
          ? "[WARN]"
          : "[PASS]";
    lines.push(`${tag} ${r.name} — ${r.message}`);
    if (r.hint && r.severity !== "pass") {
      lines.push(`        hint: ${r.hint}`);
    }
  }
  lines.push("");
  lines.push(
    `Summary: ${report.passed} pass, ${report.warned} warn, ${report.failed} fail`,
  );
  return lines.join("\n");
}

export function buildDoctorContext(opts: {
  home?: string;
  runners?: Partial<DoctorRunners>;
  manifestRepoPath?: string;
} = {}): DoctorContext {
  const home = opts.home ?? os.homedir();
  const configPath =
    opts.home != null
      ? path.join(opts.home, ".pmk", "gateway.json")
      : gatewayConfigPath();
  let exists = false;
  let mode: number | undefined;
  let config: GatewayConfig | null = null;
  let secretSources: DoctorContext["secretSources"] = {};
  if (fs.existsSync(configPath)) {
    exists = true;
    try {
      const stat = fs.statSync(configPath);
      mode = stat.mode & 0o777;
    } catch {
      // mode read fail is non-fatal — config-file check will report it
    }
    if (opts.home != null) {
      // Test-mode: read directly so we don't depend on real homedir().
      const raw = fs.readFileSync(configPath, "utf8");
      try {
        const parsed = JSON.parse(raw) as unknown;
        config = parsed as GatewayConfig;
        try {
          const rawCfg = normaliseRawConfigForTest(parsed);
          secretSources = {
            appToken: rawCfg.slack.appToken,
            botToken: rawCfg.slack.botToken,
            apiKey: rawCfg.apiKey,
          };
        } catch {
          // malformed reference in fixture — leave secretSources empty
        }
      } catch {
        // malformed JSON — config-file check will report
      }
    } else {
      try {
        config = loadGatewayConfig();
      } catch {
        // loadGatewayConfig throws on version mismatch — config-file check will surface it
      }
      try {
        const rawCfg = loadRawGatewayConfig();
        secretSources = {
          appToken: rawCfg.slack.appToken,
          botToken: rawCfg.slack.botToken,
          apiKey: rawCfg.apiKey,
        };
      } catch {
        // raw load fail is non-fatal — secret-sources check will report what it can
      }
    }
  }
  const runners: DoctorRunners = {
    slackAppAuth: opts.runners?.slackAppAuth ?? defaultSlackAppAuth,
    slackBotAuth: opts.runners?.slackBotAuth ?? defaultSlackBotAuth,
    anthropicEcho: opts.runners?.anthropicEcho ?? defaultAnthropicEcho,
    mraList: opts.runners?.mraList ?? defaultMraList,
    atomCount: opts.runners?.atomCount ?? defaultAtomCount,
    claudeCli: opts.runners?.claudeCli ?? defaultClaudeCli,
  };
  return {
    home,
    configPath,
    config,
    configFileStat: { exists, mode },
    envAnthropicKey: process.env.ANTHROPIC_API_KEY,
    llmProvider: resolveEffectiveProvider(),
    manifestRepoPath:
      opts.manifestRepoPath ??
      path.resolve(__dirname, "slack", "manifest.template.json"),
    runners,
    secretSources,
    cliApiKey: loadConfig().apiKey,
  };
}

// Mirror resolveProvider's source order so the llm-provider check
// reflects what the daemon will actually do: PMK_PROVIDER env wins,
// then the CLI config's provider field, then "auto".
function resolveEffectiveProvider(): string {
  if (process.env.PMK_PROVIDER) return process.env.PMK_PROVIDER;
  try {
    return loadConfig().provider ?? "auto";
  } catch {
    return "auto";
  }
}

async function defaultSlackAppAuth(
  token: string,
): Promise<{ ok: boolean; teamId?: string; error?: string }> {
  if (!token) return { ok: false, error: "no app-level token configured" };
  // App-Level Token (xapp-...) verified via apps.connections.open. The
  // bot tokens (xoxb-...) can't call this endpoint — only app-level
  // tokens with connections:write can.
  try {
    const res = await new WebClient(token).apps.connections.open();
    if (!res.ok) return { ok: false, error: res.error ?? "unknown" };
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function defaultSlackBotAuth(
  token: string,
): Promise<{
  ok: boolean;
  team?: string;
  user?: string;
  botId?: string;
  error?: string;
}> {
  if (!token) return { ok: false, error: "no bot token configured" };
  try {
    const res = await new WebClient(token).auth.test();
    if (!res.ok) return { ok: false, error: res.error ?? "unknown" };
    return {
      ok: true,
      team: res.team,
      user: res.user,
      botId: res.bot_id,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function defaultAnthropicEcho(
  apiKey: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!apiKey) return { ok: false, error: "no Anthropic API key configured" };
  // Minimal API call: 1 input token, 1 output token, cheapest model.
  // Under 1¢ / month even running doctor 1000x.
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "ok" }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        error: `HTTP ${res.status} ${body.slice(0, 200)}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function defaultMraList(
  workspace: string,
): Promise<{ ok: boolean; repos: string[]; error?: string }> {
  if (!workspace) return { ok: false, repos: [], error: "no workspace configured" };
  if (!fs.existsSync(workspace)) {
    return { ok: false, repos: [], error: `workspace not found: ${workspace}` };
  }
  const reposJson = path.join(workspace, ".collab", "repos.json");
  if (!fs.existsSync(reposJson)) {
    return {
      ok: false,
      repos: [],
      error: `.collab/repos.json missing in ${workspace}`,
    };
  }
  try {
    const raw = fs.readFileSync(reposJson, "utf8");
    const parsed = JSON.parse(raw) as { repos?: Record<string, unknown> };
    const repos = Object.keys(parsed.repos ?? {});
    return { ok: true, repos };
  } catch (err) {
    return {
      ok: false,
      repos: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function defaultAtomCount(scope?: string): Promise<number> {
  // Read-only count of approved atoms on disk. A missing knowledge
  // root yields 0 rather than throwing — an unseeded PKB is 0 atoms,
  // not a doctor crash.
  try {
    return approvedAtomCount(scope);
  } catch {
    return 0;
  }
}

async function defaultClaudeCli(): Promise<{
  available: boolean;
  path?: string;
}> {
  try {
    const found = findClaudeExecutable();
    return found ? { available: true, path: found } : { available: false };
  } catch {
    return { available: false };
  }
}
