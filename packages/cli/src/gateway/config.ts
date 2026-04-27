import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AudienceKey } from "@pmk/shared";

/**
 * Gateway config — what the host configures once, before
 * `pmk gateway start` works at all. Lives at ~/.pmk/gateway.json.
 *
 * Slack tokens are *secrets*; we make a best-effort to write the file
 * with 0600 mode so other local users can't read them. For multi-host
 * production setups the host should put these in a real secrets vault
 * and reference them via env (PMK_SLACK_APP_TOKEN, PMK_SLACK_BOT_TOKEN).
 */

export interface SlackConfig {
  /** xapp-... — App-Level Token with `connections:write` scope. */
  appToken?: string;
  /** xoxb-... — Bot User OAuth Token. */
  botToken?: string;
  /** Bot user ID; populated lazily after first auth.test call. */
  botUserId?: string;
  /** Workspace name (for display); populated after first auth.test. */
  workspaceName?: string;
}

/**
 * Per-user audience overrides. Audience picks which gateway-DM prompt
 * the model uses for this user — tech (default; PM/SA/eng), biz
 * (sales / ops / non-tech PM), or exec (decision-makers).
 */
export interface AudienceConfig {
  default: AudienceKey;
  /** Slack user ID → audience override. */
  users: Record<string, AudienceKey>;
}

/**
 * When the model emits an `escalate` directive, pmk picks an IT/domain
 * contact to @-mention from this pool. `repos` keys map a repo hint
 * (from the directive) to a list of Slack user IDs; `default` is used
 * when no repo hint matches.
 */
export interface EscalationConfig {
  default: string[];
  repos: Record<string, string[]>;
}

export interface GatewayConfig {
  version: 1;
  /** When set, every new session is seeded with this ingest spec. */
  defaultIngest?: string;
  /** Slack-user-IDs blocked from the bot (host-managed). */
  blocklist: string[];
  /** Audience overrides per user (tech / biz / exec). */
  audience: AudienceConfig;
  /** Pool of IT/domain contacts pmk can @-mention on `escalate`. */
  escalation: EscalationConfig;
  slack: SlackConfig;
}

export const GATEWAY_CONFIG_VERSION = 1 as const;

export function gatewayDir(): string {
  return path.join(os.homedir(), ".pmk", "gateway");
}

export function gatewayConfigPath(): string {
  return path.join(os.homedir(), ".pmk", "gateway.json");
}

export function gatewayHeartbeatPath(): string {
  return path.join(gatewayDir(), "heartbeat");
}

export function gatewayPidPath(): string {
  return path.join(gatewayDir(), "gateway.pid");
}

function defaultAudience(): AudienceConfig {
  return { default: "tech", users: {} };
}

function defaultEscalation(): EscalationConfig {
  return { default: [], repos: {} };
}

export function loadGatewayConfig(): GatewayConfig {
  const file = gatewayConfigPath();
  if (!fs.existsSync(file)) {
    return {
      version: GATEWAY_CONFIG_VERSION,
      blocklist: [],
      audience: defaultAudience(),
      escalation: defaultEscalation(),
      slack: {},
    };
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as GatewayConfig;
  if (raw.version !== GATEWAY_CONFIG_VERSION) {
    throw new Error(
      `gateway config has version ${raw.version}, this build expects ${GATEWAY_CONFIG_VERSION}`,
    );
  }
  // Back-fill fields added in later builds so old configs still load.
  if (!raw.audience) raw.audience = defaultAudience();
  if (!raw.audience.users) raw.audience.users = {};
  if (!raw.escalation) raw.escalation = defaultEscalation();
  if (!raw.escalation.repos) raw.escalation.repos = {};
  if (!raw.escalation.default) raw.escalation.default = [];
  // Env overrides — handy for CI / containerised hosts.
  raw.slack.appToken = process.env.PMK_SLACK_APP_TOKEN ?? raw.slack.appToken;
  raw.slack.botToken = process.env.PMK_SLACK_BOT_TOKEN ?? raw.slack.botToken;
  return raw;
}

/**
 * Pick the audience for a specific user. Falls back to the default
 * audience when no per-user override is set.
 */
export function pickAudience(cfg: GatewayConfig, userId: string): AudienceKey {
  return cfg.audience?.users?.[userId] ?? cfg.audience?.default ?? "tech";
}

/**
 * Pick the escalation pool for a given repo hint. Falls back to the
 * default pool. Returns an empty array if neither is configured.
 */
export function pickEscalationPool(
  cfg: GatewayConfig,
  repo: string | undefined,
): string[] {
  if (repo && cfg.escalation?.repos?.[repo]?.length) {
    return cfg.escalation.repos[repo];
  }
  return cfg.escalation?.default ?? [];
}

export function saveGatewayConfig(cfg: GatewayConfig): string {
  const file = gatewayConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  // Tighten existing-file permissions in case the file was created with
  // the umask default.
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* non-POSIX or permission issue — best-effort */
  }
  return file;
}

export function isGatewayConfigured(cfg: GatewayConfig): boolean {
  return Boolean(cfg.slack.appToken && cfg.slack.botToken);
}

export function hasValidSlackTokens(cfg: GatewayConfig): boolean {
  if (!cfg.slack.appToken || !cfg.slack.botToken) return false;
  return (
    cfg.slack.appToken.startsWith("xapp-") &&
    cfg.slack.botToken.startsWith("xoxb-")
  );
}
