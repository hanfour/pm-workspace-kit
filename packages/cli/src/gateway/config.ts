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
import {
  acquireAuthorizationLockSync,
  releaseAuthorizationLock,
} from "./authorization-lock";

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

export interface AudioConfig {
  openaiApiKey?: unknown; // SecretSource on disk; validated lazily
  model?: string;
  language?: string;
  enabled?: boolean;
  maxDurationSec?: number;
  quota?: { perUserDailyMinutes?: number; globalDailyMinutes?: number; globalMonthlyMinutes?: number };
}

export interface ResolvedAudioConfig {
  enabled: boolean;
  model: string;
  language: string;
  maxDurationSec: number;
  perUserDailyMinutes: number;
  globalDailyMinutes: number;
  /** Whole-workspace monthly budget ceiling in minutes; undefined = no monthly cap. */
  globalMonthlyMinutes?: number;
}

export interface ReviewConfig {
  enabled: boolean;
  approval: { enabled: boolean };
  allowPublicRepos: boolean;
  repoAllowlist?: string[];          // e.g. ["onead/OnePixel"]; undefined = any private repo in workspace
  maxPrsPerTrigger: number;
  maxConcurrent: number;
  maxConcurrentPerUser: number;
  strategy: "debate" | "personas" | "standard";
  /**
   * Provider policy passed through to mra review. Defaults to codex so the
   * Slack gateway does not consume Claude quota unless an admin opts in.
   * "fallback" means mra tries primary then secondary; "dual" runs both and
   * merges their findings when the installed mra supports it.
   */
  providerMode: "codex" | "claude" | "fallback" | "dual";
  expectedGhUser?: string;           // gate: gh api user must equal this before posting
  /**
   * Pinned GitHub token for PMK-owned review interactions (PR head, repo
   * visibility, actor verification, review publication, approval). Literal or {env}/{cmd}
   * secret reference. When set, the review uses THIS token's identity —
   * stable, independent of the host's active `gh` account. Recommended:
   * `{ "cmd": "gh auth token --user <work-account>" }` (no raw token on disk,
   * no active-account switch). Unset → host ambient gh (default).
   */
  ghToken?: SecretSource;
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
  /** Configuration for audio (voice message) transcription feature. */
  audio?: AudioConfig;
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

export function reviewWorkspaceDir(): string {
  // gatewayDir() returns ~/.pmk/gateway; dirname gives ~/.pmk; review workspace is a sibling.
  return path.join(path.dirname(gatewayDir()), "review-workspace");
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
  // `:cr:` review config. Carried through as a Partial<ReviewConfig>;
  // `resolveReviewConfig` applies defaults / clamps / enum normalization at use
  // time. Only the known, well-typed fields survive (unknown keys dropped).
  const rawReview = (r as { review?: unknown }).review;
  const review = normaliseReviewConfig(rawReview);
  // Existing configs predate provider selection and therefore had effective
  // Claude/debate behavior. Preserve that on load; only genuinely new configs
  // (no review block) receive the Codex/standard fresh-install default.
  if (review && rawReview && typeof rawReview === "object" &&
      !("providerMode" in (rawReview as Record<string, unknown>))) {
    review.providerMode = "claude";
    if (!("strategy" in (rawReview as Record<string, unknown>))) review.strategy = "debate";
  }
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
    review,
    audio: r.audio as AudioConfig | undefined,
  };
}

/**
 * Extract the known fields of a raw `review` config block into a typed
 * Partial<ReviewConfig>. Returns undefined when absent/not-an-object.
 * Lenient on value sanity (resolveReviewConfig clamps/guards downstream);
 * strict on types so junk never reaches the runtime.
 */
function normaliseReviewConfig(raw: unknown): Partial<ReviewConfig> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const out: Partial<ReviewConfig> = {};
  if (typeof o.enabled === "boolean") out.enabled = o.enabled;
  if (o.approval && typeof o.approval === "object") {
    const approval = o.approval as Record<string, unknown>;
    if (typeof approval.enabled === "boolean")
      out.approval = { enabled: approval.enabled };
  }
  if (typeof o.allowPublicRepos === "boolean")
    out.allowPublicRepos = o.allowPublicRepos;
  if (Array.isArray(o.repoAllowlist))
    out.repoAllowlist = asStringArray(o.repoAllowlist);
  if (typeof o.maxPrsPerTrigger === "number")
    out.maxPrsPerTrigger = o.maxPrsPerTrigger;
  if (typeof o.maxConcurrent === "number") out.maxConcurrent = o.maxConcurrent;
  if (typeof o.maxConcurrentPerUser === "number") out.maxConcurrentPerUser = o.maxConcurrentPerUser;
  if (o.strategy === "debate" || o.strategy === "personas" || o.strategy === "standard")
    out.strategy = o.strategy;
  if (o.providerMode === "codex" || o.providerMode === "claude" || o.providerMode === "fallback" || o.providerMode === "dual")
    out.providerMode = o.providerMode;
  if (typeof o.expectedGhUser === "string")
    out.expectedGhUser = o.expectedGhUser;
  const ghToken = validateSecretSource(o.ghToken, "review.ghToken");
  if (ghToken !== undefined) out.ghToken = ghToken;
  return out;
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
 * to >=1, defaults providerMode to "codex", and normalizes `strategy` to
 * "debate" unless explicitly "personas" or "standard".
 */
export function resolveReviewConfig(raw?: Partial<ReviewConfig>): ReviewConfig {
  return {
    enabled: raw?.enabled ?? false,
    approval: { enabled: raw?.approval?.enabled ?? false },
    allowPublicRepos: raw?.allowPublicRepos ?? false,
    repoAllowlist: raw?.repoAllowlist,
    maxPrsPerTrigger: Math.max(1, raw?.maxPrsPerTrigger ?? 5),
    maxConcurrent: Math.max(1, raw?.maxConcurrent ?? 2),
    maxConcurrentPerUser: Math.max(1, raw?.maxConcurrentPerUser ?? 1),
    strategy: raw?.strategy === "personas" ? "personas"
      : raw?.strategy === "debate" ? "debate" : "standard",
    providerMode: raw?.providerMode === "claude" ? "claude"
      : raw?.providerMode === "fallback" ? "fallback"
      : raw?.providerMode === "dual" ? "dual" : "codex",
    expectedGhUser: raw?.expectedGhUser,
    ghToken: raw?.ghToken,
  };
}

/**
 * Resolve the pinned review GitHub token (literal or {env}/{cmd}). When set,
 * every PMK-owned review GitHub call uses this token — a stable
 * identity independent of the host's active `gh` account. Returns undefined
 * when unset (→ host ambient gh, the default). Resolved lazily at review time.
 */
export function resolveReviewGhToken(
  review: Partial<ReviewConfig> | undefined,
): string | undefined {
  return resolveSecret(review?.ghToken, "review.ghToken");
}

/**
 * Resolve the audio config with safe defaults.
 */
export function resolveAudioConfig(raw?: AudioConfig): ResolvedAudioConfig {
  return {
    enabled: raw?.enabled ?? false,
    // whisper-1: gpt-4o-mini-transcribe has a ~25-min token cap (400
    // input_too_large) that breaks long meeting recordings. whisper-1 is
    // bounded only by the 25MB request size, which the re-encode satisfies.
    model: raw?.model ?? "whisper-1",
    language: raw?.language ?? "zh",
    maxDurationSec: raw?.maxDurationSec ?? 7200,
    perUserDailyMinutes: raw?.quota?.perUserDailyMinutes ?? 120,
    globalDailyMinutes: raw?.quota?.globalDailyMinutes ?? 600,
    globalMonthlyMinutes: raw?.quota?.globalMonthlyMinutes,
  };
}

/**
 * Resolve the OpenAI API key from the audio config block (literal or
 * {env}/{cmd} reference). Returns undefined when unset. Resolved lazily
 * at transcription time, never at load.
 */
export function resolveOpenAiKey(raw?: AudioConfig): string | undefined {
  const src = validateSecretSource(raw?.openaiApiKey, "audio.openaiApiKey");
  return resolveSecret(src, "audio.openaiApiKey");
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
  // #90: every config write serializes with the GitHub-approve POST critical
  // section via the shared authorization lock. While an approve is in flight
  // this throws AuthorizationLockBusyError instead of writing around it —
  // callers surface "approve 進行中，請稍後重試" honestly. (The config ↔
  // authorization-lock import cycle is safe: both sides only touch the other
  // at call time, never at module init.)
  const lock = acquireAuthorizationLockSync();
  try {
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
  } finally {
    releaseAuthorizationLock(lock);
  }
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
