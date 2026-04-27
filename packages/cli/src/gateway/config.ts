import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

export interface GatewayConfig {
  version: 1;
  /** When set, every new session is seeded with this ingest spec. */
  defaultIngest?: string;
  /** Slack-user-IDs blocked from the bot (host-managed). */
  blocklist: string[];
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

export function loadGatewayConfig(): GatewayConfig {
  const file = gatewayConfigPath();
  if (!fs.existsSync(file)) {
    return {
      version: GATEWAY_CONFIG_VERSION,
      blocklist: [],
      slack: {},
    };
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as GatewayConfig;
  if (raw.version !== GATEWAY_CONFIG_VERSION) {
    throw new Error(
      `gateway config has version ${raw.version}, this build expects ${GATEWAY_CONFIG_VERSION}`,
    );
  }
  // Env overrides — handy for CI / containerised hosts.
  raw.slack.appToken = process.env.PMK_SLACK_APP_TOKEN ?? raw.slack.appToken;
  raw.slack.botToken = process.env.PMK_SLACK_BOT_TOKEN ?? raw.slack.botToken;
  return raw;
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
