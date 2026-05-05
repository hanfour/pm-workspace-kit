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
 * Audience overrides. Audience picks which gateway-DM prompt the
 * model uses for a turn — tech (default; PM/SA/eng), pm
 * (product-flavored), biz (sales / ops / non-tech), or exec
 * (decision-makers).
 *
 * Resolution order at turn time (#23): per-user override → per-channel
 * override → workspace default. Per-user always wins; channel default
 * lets a host say "everyone in #leadership defaults to exec" without
 * setting 12 individual user overrides.
 */
export interface AudienceConfig {
  default: AudienceKey;
  /** Slack user ID → audience override. */
  users: Record<string, AudienceKey>;
  /** Slack channel ID → audience default for the channel (#23). */
  channels: Record<string, AudienceKey>;
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
  /**
   * Slack user IDs allowed to run `/pmk admin <subcmd>` from inside
   * Slack (v0.9). Empty = no admins via Slack; host CLI is the only
   * admin path. Bootstrap requires terminal access — there's no way
   * to grant yourself admin via Slack, by design.
   */
  admins: string[];
  /** When set, every new session is seeded with this ingest spec. */
  defaultIngest?: string;
  /**
   * Absolute path to the mra workspace (the directory holding
   * `.collab/repos.json`). When set, `mraDoctor` uses this directly
   * instead of walking up from the gateway's launch cwd — so
   * `pmk gateway start` can be run from any directory and mra-ask /
   * PKB seed still know where to look.
   *
   * When unset, falls back to the v0.7.0 behaviour (cwd-walk).
   */
  mraWorkspace?: string;
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
  return { default: "tech", users: {}, channels: {} };
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
      admins: [],
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
  if (!raw.audience.channels) raw.audience.channels = {};
  if (!raw.escalation) raw.escalation = defaultEscalation();
  if (!raw.escalation.repos) raw.escalation.repos = {};
  if (!raw.escalation.default) raw.escalation.default = [];
  if (!Array.isArray(raw.admins)) raw.admins = [];
  // Env overrides — handy for CI / containerised hosts.
  raw.slack.appToken = process.env.PMK_SLACK_APP_TOKEN ?? raw.slack.appToken;
  raw.slack.botToken = process.env.PMK_SLACK_BOT_TOKEN ?? raw.slack.botToken;
  raw.mraWorkspace = process.env.PMK_MRA_WORKSPACE ?? raw.mraWorkspace;
  return raw;
}

/**
 * Pick the audience for a turn (#23):
 *   1. per-user override (cfg.audience.users[userId])
 *   2. per-channel override (cfg.audience.channels[channelId])
 *   3. workspace default (cfg.audience.default)
 *   4. hard fallback ("tech") if nothing is configured
 *
 * `channelId` is optional so DM call sites that don't have a real
 * channel context (e.g., user-DM where channelId is the DM channel's
 * `D...` ID — equivalent to the user) can still call this function;
 * unmatched channelIds simply fall through to step 3.
 */
export function pickAudience(
  cfg: GatewayConfig,
  userId: string,
  channelId?: string,
): AudienceKey {
  return (
    cfg.audience?.users?.[userId] ??
    (channelId !== undefined
      ? cfg.audience?.channels?.[channelId]
      : undefined) ??
    cfg.audience?.default ??
    "tech"
  );
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

/**
 * Same as `pickEscalationPool` but filters the asker out so the bot
 * never @-mentions the person who just asked the question. Used by
 * `handleEscalation` to surface a config gap (#30 v0.8.2): when the
 * effective pool is empty, the host gets a visible Slack warning
 * instead of a silent prose-degrade.
 */
export function pickEffectiveEscalationPool(
  cfg: GatewayConfig,
  repo: string | undefined,
  askerUserId: string,
): string[] {
  return pickEscalationPool(cfg, repo).filter((id) => id !== askerUserId);
}

/**
 * v0.9 (#31): is this Slack user authorised to run `/pmk admin`
 * subcommands? Bootstrap requires terminal access — there's no
 * "/pmk admin admins add @first-admin" path because no one is yet
 * admin to authorise it.
 */
export function isAdmin(cfg: GatewayConfig, userId: string): boolean {
  return Array.isArray(cfg.admins) && cfg.admins.includes(userId);
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
