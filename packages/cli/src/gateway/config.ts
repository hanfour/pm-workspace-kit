import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AUDIENCE_KEYS,
  type AudienceDomainExamples,
  type AudienceKey,
} from "@pmk/shared";
import {
  type SecretSource,
  validateSecretSource,
  resolveSecret,
} from "./secret-source";

/**
 * Gateway config — what the host configures once, before
 * `pmk gateway start` works at all. Lives at ~/.pmk/gateway.json.
 *
 * Slack tokens are *secrets*; we make a best-effort to write the file
 * with 0600 mode so other local users can't read them. For multi-host
 * production setups the host should put these in a real secrets vault
 * and reference them via env (PMK_SLACK_APP_TOKEN, PMK_SLACK_BOT_TOKEN).
 */

/** Resolved Slack config consumers see (tokens are plain strings). */
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

/** On-disk Slack config: tokens may be a literal or a {env}/{cmd} reference. */
export interface RawSlackConfig {
  appToken?: SecretSource;
  botToken?: SecretSource;
  botUserId?: string;
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
  /**
   * v0.15.0: per-tier workspace-specific translation rows the operator
   * registered via `pmk gateway audience example add <tier> ...`.
   * Appended to the shared BIZ / PM cheat-sheet at prompt-assembly
   * time. Only `biz` and `pm` are honoured; the schema accepts
   * future tiers for forward compatibility.
   *
   * Same in-memory snapshot caveat as the rest of `audience`:
   * mutations on disk require a graceful restart to take effect.
   */
  domainExamples?: AudienceDomainExamples;
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

export interface ReviewConfig {
  enabled: boolean;
  allowPublicRepos: boolean;
  repoAllowlist?: string[];          // e.g. ["onead/OnePixel"]; undefined = any private repo in workspace
  maxPrsPerTrigger: number;
  strategy: "debate" | "personas";
  expectedGhUser?: string;           // gate: gh api user must equal this before posting
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
  /**
   * Anthropic API key — a literal or a {env}/{cmd} reference. Resolved
   * lazily at the provider merge (see resolveGatewayApiKey), NOT at load,
   * so a gateway {cmd} never runs when the CLI config already supplies a key.
   */
  apiKey?: SecretSource;
  /**
   * Work GitHub credentials for the confirmed-problem → issue flow.
   * `token` is a literal or {env}/{cmd} reference, resolved lazily at
   * 🎫 time (see resolveGithubToken) so a {cmd} never runs at load.
   * `allowPublicRepos` (default false) blocks opening issues on a PUBLIC
   * repo — internal diagnosis content must not leak to a public repo.
   */
  github?: { token: SecretSource; allowPublicRepos?: boolean };
  /** Configuration for `:cr:` reaction → mra PR review feature. */
  review?: Partial<ReviewConfig>;
  slack: SlackConfig;
}

/** On-disk gateway config — secret fields are unresolved `SecretSource`. */
export interface RawGatewayConfig extends Omit<GatewayConfig, "slack"> {
  slack: RawSlackConfig;
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

/**
 * v0.10.x (#44): single-use marker dropped during graceful shutdown
 * so the next start can distinguish "kill -> restart" from a true
 * crash. Read-and-deleted on the next `startHeartbeat()`.
 */
export function gatewayShutdownMarkerPath(): string {
  return path.join(gatewayDir(), "shutdown-marker");
}

function defaultAudience(): AudienceConfig {
  // v0.13.2: re-flipped pm → biz after live verification. v0.13.1's
  // `pm` tier still allows file paths and model names (PM tier is
  // designed for "PM who briefs engineers" — code refs are intentional).
  // For workspaces where the typical unknown user is a true non-IT
  // stakeholder (sales / ops / exec-adjacent), `biz` is the right
  // default: jargon mandatory-translated ("AdFormat" → 「廣告版型」,
  // "scope" → 「篩選條件」), no code blocks unless quoting a
  // SQL/API the user must run, implementation collapsed into "想看實作
  //可以問 IT". Both PM and IT users opt into their richer tier via
  // explicit per-user override (`/pmk admin audience set <@user> pm`
  // or `tech`).
  return { default: "biz", users: {}, channels: {} };
}

function defaultEscalation(): EscalationConfig {
  return { default: [], repos: {} };
}

/** Keep only the genuine strings from an untrusted array-ish value. */
function asStringArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

/** A `Record<string, T>` where every value passes `keep`; others dropped. */
function asStringRecord<T>(
  v: unknown,
  keep: (val: unknown) => val is T,
): Record<string, T> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, T> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (keep(val)) out[k] = val;
  }
  return out;
}

const isAudienceKey = (v: unknown): v is AudienceKey =>
  typeof v === "string" && (AUDIENCE_KEYS as readonly string[]).includes(v);

const asString = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

/**
 * Coerce an untrusted parsed config into a valid, fully-populated
 * `GatewayConfig`. The file on disk is external data we never trust
 * blindly (#review): a tampered or partially-written `gateway.json`
 * could otherwise make `admins` a non-array (silently bypassing
 * `isAdmin`'s `Array.isArray` guard) or `blocklist` a non-array (whose
 * `.includes()` would throw and crash the daemon). Security-critical
 * arrays are filtered to strings; missing fields are back-filled.
 *
 * Pure + immutable: builds a new object, never mutates `raw`.
 */
function normaliseRawConfig(raw: unknown): RawGatewayConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  if (r.version !== GATEWAY_CONFIG_VERSION) {
    throw new Error(
      `gateway config has version ${r.version}, this build expects ${GATEWAY_CONFIG_VERSION}`,
    );
  }
  const aRaw = (
    r.audience && typeof r.audience === "object" ? r.audience : {}
  ) as Record<string, unknown>;
  const deRaw = (
    aRaw.domainExamples && typeof aRaw.domainExamples === "object"
      ? aRaw.domainExamples
      : {}
  ) as Record<string, unknown>;
  const audience: AudienceConfig = {
    default: isAudienceKey(aRaw.default) ? aRaw.default : "biz",
    users: asStringRecord(aRaw.users, isAudienceKey),
    channels: asStringRecord(aRaw.channels, isAudienceKey),
    domainExamples: {
      biz: Array.isArray(deRaw.biz)
        ? (deRaw.biz as AudienceDomainExamples["biz"])
        : [],
      pm: Array.isArray(deRaw.pm)
        ? (deRaw.pm as AudienceDomainExamples["pm"])
        : [],
    },
  };
  const eRaw = (
    r.escalation && typeof r.escalation === "object" ? r.escalation : {}
  ) as Record<string, unknown>;
  const reposRaw = asStringRecord(eRaw.repos, (v): v is unknown[] =>
    Array.isArray(v),
  );
  const repos: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(reposRaw)) repos[k] = asStringArray(v);
  const escalation: EscalationConfig = {
    default: asStringArray(eRaw.default),
    repos,
  };
  const sRaw = (
    r.slack && typeof r.slack === "object" ? r.slack : {}
  ) as Record<string, unknown>;
  const slack: RawSlackConfig = {
    appToken: validateSecretSource(sRaw.appToken, "slack.appToken"),
    botToken: validateSecretSource(sRaw.botToken, "slack.botToken"),
    botUserId: asString(sRaw.botUserId),
    workspaceName: asString(sRaw.workspaceName),
  };
  const rawGithub = (r as { github?: unknown }).github;
  const github =
    rawGithub && typeof rawGithub === "object" && "token" in rawGithub
      ? {
          token: validateSecretSource(
            (rawGithub as { token?: unknown }).token,
            "github.token",
          )!,
          ...((rawGithub as { allowPublicRepos?: unknown }).allowPublicRepos === true
            ? { allowPublicRepos: true as const }
            : {}),
        }
      : undefined;
  return {
    version: GATEWAY_CONFIG_VERSION,
    admins: asStringArray(r.admins),
    blocklist: asStringArray(r.blocklist),
    audience,
    escalation,
    slack,
    defaultIngest: asString(r.defaultIngest),
    mraWorkspace: asString(r.mraWorkspace),
    apiKey: validateSecretSource(r.apiKey, "apiKey"),
    github,
  };
}

/** Test seam — exercises normaliseRawConfig without touching disk. */
export function normaliseRawConfigForTest(raw: unknown): RawGatewayConfig {
  return normaliseRawConfig(raw);
}

/** Resolve one Slack token: fixed-name env override wins (nullish), else the
 * on-disk reference. The override short-circuits BEFORE the reference runs. */
function resolveSlackToken(
  envName: string,
  src: SecretSource | undefined,
  secretName: string,
): string | undefined {
  const override = process.env[envName];
  return override ?? resolveSecret(src, secretName);
}

/** Read + normalise the on-disk config WITHOUT resolving any secret. */
export function loadRawGatewayConfig(): RawGatewayConfig {
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
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  return normaliseRawConfig(raw);
}

/** Runtime config consumers see: Slack tokens resolved eagerly (override
 * short-circuit + PMK_MRA_WORKSPACE); apiKey left raw for the provider merge. */
export function loadGatewayConfig(): GatewayConfig {
  const raw = loadRawGatewayConfig();
  return {
    ...raw,
    mraWorkspace: process.env.PMK_MRA_WORKSPACE ?? raw.mraWorkspace,
    slack: {
      appToken: resolveSlackToken(
        "PMK_SLACK_APP_TOKEN",
        raw.slack.appToken,
        "slack.appToken",
      ),
      botToken: resolveSlackToken(
        "PMK_SLACK_BOT_TOKEN",
        raw.slack.botToken,
        "slack.botToken",
      ),
      botUserId: raw.slack.botUserId,
      workspaceName: raw.slack.workspaceName,
    },
  };
}

/**
 * Resolve the effective Anthropic key. The CLI config key wins ONLY when it is
 * a non-empty string (matching the old truthy fallback); otherwise the gateway
 * reference resolves. Shared by slack/index.ts (value) and doctor (label +
 * whether to validate the reference), so the "does the {cmd} run?" decision
 * can't drift.
 */
export function resolveGatewayApiKey(
  cliApiKey: string | undefined,
  rawGatewayApiKey: SecretSource | undefined,
): { value: string | undefined; usedCliConfig: boolean } {
  if (typeof cliApiKey === "string" && cliApiKey !== "") {
    return { value: cliApiKey, usedCliConfig: true };
  }
  return { value: resolveSecret(rawGatewayApiKey, "apiKey"), usedCliConfig: false };
}

/**
 * Resolve the work GitHub token from the gateway config (literal or
 * {env}/{cmd}). Mirrors resolveGatewayApiKey; returns undefined if unset.
 * Resolved lazily at 🎫 time, never at load.
 */
export function resolveGithubToken(
  github: GatewayConfig["github"],
): string | undefined {
  return resolveSecret(github?.token, "github.token");
}

/**
 * Resolve the review config with safe defaults. Clamps `maxPrsPerTrigger`
 * to >=1 and normalizes `strategy` to "debate" unless explicitly "personas".
 */
export function resolveReviewConfig(raw?: Partial<ReviewConfig>): ReviewConfig {
  return {
    enabled: raw?.enabled ?? false,
    allowPublicRepos: raw?.allowPublicRepos ?? false,
    repoAllowlist: raw?.repoAllowlist,
    maxPrsPerTrigger: Math.max(1, raw?.maxPrsPerTrigger ?? 5),
    strategy: raw?.strategy === "personas" ? "personas" : "debate",
    expectedGhUser: raw?.expectedGhUser,
  };
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
  // Truthy check on channelId rather than `!== undefined` so an empty
  // string accidentally passed through (e.g., a stripped Slack envelope)
  // doesn't query `cfg.audience.channels[""]` and pull a key the host
  // never explicitly set.
  return (
    cfg.audience?.users?.[userId] ??
    (channelId ? cfg.audience?.channels?.[channelId] : undefined) ??
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

export function saveGatewayConfig(cfg: RawGatewayConfig): string {
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
