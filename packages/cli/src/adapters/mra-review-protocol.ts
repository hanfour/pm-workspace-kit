/**
 * Pure protocol helpers for `mra review`: the result shape, strategy/provider
 * types, the argv builder, the stdout parser, and the scrubbed review env.
 * No process spawning lives here — runMraReview (mra.ts) wires these into the
 * shared spawn loop. Extracted so the parse/argv/env contract is unit-testable
 * and separate from the spawn machinery.
 */
import { strippedChildEnv } from "./mra-env";

export interface MraReviewResult {
  ok: boolean;
  status?: string;
  commentCount?: number;
  blockerCount?: number;
  protocolVersion?: "1.0";
  artifactSha256?: string;
  analyzedHeadSha?: string;
  summary?: string;
  findings?: Array<{ path: string; line: number; body: string; severity?: string }>;
  /** True when mra posted a neutral REVIEW_INCOMPLETE placeholder (see parseReviewStdout). */
  incomplete?: boolean;
  stdout: string;
  stderr: string;
  reason?: string;
}

export type ReviewStrategy = "debate" | "personas" | "standard";
export type ReviewProviderMode = "codex" | "claude" | "fallback" | "dual";

/**
 * Build the argv for `mra review <project> --pr <pr>`. For strategy
 * "debate" appends `--strategy debate`; for "standard" appends
 * `--strategy standard`; for "personas" the flag is omitted and the
 * env var `MRA_REVIEW_PERSONAS=true` is used instead (see {@link reviewEnv}).
 * Provider policy is always explicit. If the configured provider is unsupported
 * by the installed mra, the review should fail visibly rather than silently
 * running a different provider.
 */
export function buildReviewArgv(
  project: string,
  pr: number,
  strategy: ReviewStrategy,
  providerMode?: ReviewProviderMode,
): string[] {
  const base = ["review", project, "--pr", String(pr)];
  if (providerMode) base.push("--provider", providerMode);
  if (strategy === "debate") return [...base, "--strategy", "debate"];
  if (strategy === "standard") return [...base, "--strategy", "standard"];
  return base; // personas → env flag only
}

/**
 * Pure: pull status + comment count from `mra review` stdout.
 *
 * Verified against the real mra source (read-only, 2026-06-23): the
 * success path logs both lines to STDOUT via log_progress/log_info
 * (only log_error → stderr; multi-repo-agent lib/colors.sh:21-28), and
 * _log emits `<ansi>[review]<reset> <message>` so the MESSAGE text is
 * plain (no ANSI inside it). The two source lines are:
 *   review.sh:695  `posting inline review to <slug>#<N> (<N> comments)...`
 *   review.sh:710  `status: <STATUS> | comments: <N>`
 * so the regexes below match the real format. Caveat: the batch-failed
 * individual-comment fallback path (review.sh:712+) does not print the
 * `status: …` line, so on that rarer path status falls back to COMMENT.
 *
 * Matches:
 *   `status: CHANGES_REQUESTED`  → status field
 *   `(3 comments)`               → commentCount field
 *
 * Uses the LAST match of each, not the first: mra's authoritative summary lines
 * (review.sh:842/857) are emitted at the very end, AFTER any PR diff content is
 * echoed in progress output. A decoy `status: APPROVED` inside the reviewed diff
 * must not spoof the outcome the gateway then reports to Slack.
 */
export function parseReviewStdout(stdout: string): {
  status?: string;
  commentCount?: number;
  blockerCount?: number;
  incomplete: boolean;
} {
  const status = [...stdout.matchAll(/status:\s*([A-Z_]+)/g)].at(-1)?.[1];
  const cc = [...stdout.matchAll(/\((\d+)\s+comments?\)/g)].at(-1)?.[1];
  const blockers = [...stdout.matchAll(/blockers:\s*(\d+)/g)].at(-1)?.[1];
  // REVIEW_INCOMPLETE: mra's single-pass claude emitted no completion sentinel /
  // an empty / unparseable response, so mra EXITS 0 but posts a neutral placeholder
  // review whose GitHub event is COMMENT (review.sh:516 "posting REVIEW_INCOMPLETE";
  // review-verdict.sh "⚠️ REVIEW_INCOMPLETE — … This is NOT an approval; re-run or
  // review manually."). The `status:` line therefore reads COMMENT and the token is
  // the ONLY honest signal the review never actually evaluated the PR. Both emissions
  // are mra-authored progress lines (not diff echo), so a plain token match is safe.
  const incomplete = /REVIEW_INCOMPLETE/.test(stdout);
  return {
    status,
    commentCount: cc !== undefined ? Number(cc) : undefined,
    ...(blockers !== undefined ? { blockerCount: Number(blockers) } : {}),
    incomplete,
  };
}

/** Clone process.env, strip secrets, set the personas flag,
 * and cap the round-1 review agents' turns (see body). */
export function reviewEnv(
  strategy: ReviewStrategy,
  opts: {
    providerMode?: ReviewProviderMode;
    expectedHeadSha?: string;
  } = {},
): NodeJS.ProcessEnv {
  const env = strippedChildEnv();
  // Privilege flags are never inherited. They are not secret-shaped, so the
  // general denylist does not remove them; delete them explicitly to preserve
  // the analysis-only integration boundary.
  delete env.MRA_REVIEW_ALLOW_APPROVE;
  delete env.MRA_REVIEW_APPROVE_IF_NO_HIGH;
  delete env.MRA_REVIEW_PERSONAS;
  delete env.MRA_REVIEW_PROVIDER;
  delete env.MRA_REVIEW_ADMIN_OVERRIDE;
  delete env.MRA_REVIEW_EXPECTED_HEAD_SHA;
  if (strategy === "personas") env.MRA_REVIEW_PERSONAS = "true";
  if (opts.providerMode) {
    env.MRA_REVIEW_PROVIDER = opts.providerMode;
    env.MRA_REVIEW_ADMIN_OVERRIDE = "1";
  }
  if (opts.expectedHeadSha) env.MRA_REVIEW_EXPECTED_HEAD_SHA = opts.expectedHeadSha;
  // Cap the debate round-1 agents' turns generously. --max-turns is a CAP, not a
  // target: a PKB-backed review finishes well under it (the agent stops at its
  // verdict sentinel), so the headroom costs nothing on fast reviews and rescues
  // PKB-less / large PRs from a mid-exploration cutoff (which mra now honestly
  // reports as REVIEW_INCOMPLETE). Fits within runMraReview's 10-min timeout. An
  // operator-set value (env / gateway) wins.
  if (!env.MRA_REVIEW_AGENT_MAX_TURNS) env.MRA_REVIEW_AGENT_MAX_TURNS = "40";
  return env;
}
