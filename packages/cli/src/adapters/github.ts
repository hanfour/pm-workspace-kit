/**
 * gh-CLI wrapper for opening GitHub issues with a per-command work
 * token (GH_TOKEN env), mirroring adapters/mra.ts. Every shell-out goes
 * through an injectable GithubExec so tests never spawn a real process.
 *
 * NO-LEAK CONTRACT: error messages name only an exit code. The token,
 * stdout and stderr (any of which may carry the secret or an authed URL)
 * are never put into a thrown message, a Slack reply, or a host log line.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GithubExecOpts {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}
export type GithubExec = (
  file: string,
  args: string[],
  opts: GithubExecOpts,
) => Promise<{ stdout: string }>;

export interface GithubDeps {
  exec?: GithubExec;
  findBinary?: () => string | undefined;
}

const defaultExec: GithubExec = async (file, args, opts) => {
  const { stdout } = await execFileAsync(file, args, {
    env: opts.env,
    timeout: opts.timeoutMs,
    encoding: "utf8",
  });
  return { stdout };
};

const FALLBACK_GH_PATHS = [
  "/opt/homebrew/bin/gh",
  "/usr/local/bin/gh",
  "/usr/bin/gh",
];

/** Locate the gh binary on PATH (or a known fallback). Mirrors findMraBinary. */
export function findGhBinary(): string | undefined {
  if (process.env.PMK_SKIP_GH_PROBE === "1") return undefined;
  try {
    const found = execFileSync("which", ["gh"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (found) return found;
  } catch {
    /* not on PATH — try fallbacks */
  }
  for (const p of FALLBACK_GH_PATHS) {
    const expanded = p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
    if (existsSync(expanded)) return expanded;
  }
  return undefined;
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * A repo id is a safe relative path: `/`-joined segments, each matching
 * [A-Za-z0-9._-], none empty or "..". Rejects absolute paths, backslash,
 * NUL, and traversal — so path.join(workspace, repo) stays in-workspace.
 */
export function isSafeRepoPath(repo: string): boolean {
  if (!repo || repo.includes("\0") || repo.includes("\\")) return false;
  if (path.isAbsolute(repo)) return false;
  const segs = repo.split("/");
  return segs.every((s) => s.length > 0 && s !== "." && s !== ".." && SAFE_SEGMENT.test(s));
}

function parseGithubSlug(originUrl: string): string | undefined {
  const url = originUrl.trim();
  // git@github.com:owner/repo(.git)
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  // https://github.com/owner/repo(.git)
  const https = /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (https) return `${https[1]}/${https[2]}`;
  return undefined;
}

/** Resolve a repo id to "owner/repo" from its git origin. Undefined if underivable. */
export async function resolveRepoSlug(
  workspace: string,
  repo: string,
  deps: GithubDeps = {},
): Promise<string | undefined> {
  if (!isSafeRepoPath(repo)) return undefined;
  const exec = deps.exec ?? defaultExec;
  const repoPath = path.join(workspace, repo);
  try {
    const { stdout } = await exec(
      "git",
      ["-C", repoPath, "remote", "get-url", "origin"],
      { timeoutMs: 10_000 },
    );
    return parseGithubSlug(stdout);
  } catch {
    return undefined;
  }
}

/** Best-effort visibility check via `gh repo view`. Any error → "unknown". */
export async function repoVisibility(
  args: { slug: string; token?: string },
  deps: GithubDeps = {},
): Promise<"public" | "private" | "unknown"> {
  const exec = deps.exec ?? defaultExec;
  const findBinary = deps.findBinary ?? findGhBinary;
  const gh = findBinary() ?? "gh";
  try {
    const { stdout } = await exec(
      gh,
      ["repo", "view", args.slug, "--json", "visibility", "-q", ".visibility"],
      {
        env: args.token ? { ...process.env, GH_TOKEN: args.token } : process.env,
        timeoutMs: 15_000,
      },
    );
    const v = stdout.trim().toLowerCase();
    if (v === "public") return "public";
    if (v === "private" || v === "internal") return "private";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** Create an issue via `gh issue create`. Returns the URL. No-leak on error. */
export async function createIssue(
  args: { slug: string; title: string; body: string; token: string },
  deps: GithubDeps = {},
): Promise<string> {
  const exec = deps.exec ?? defaultExec;
  const findBinary = deps.findBinary ?? findGhBinary;
  const gh = findBinary() ?? "gh";
  try {
    const { stdout } = await exec(
      gh,
      ["issue", "create", "-R", args.slug, "--title", args.title, "--body", args.body],
      { env: { ...process.env, GH_TOKEN: args.token }, timeoutMs: 30_000 },
    );
    return stdout.trim();
  } catch (err) {
    // NO-LEAK: name only the exit code; never the token / stdout / stderr.
    const code = (err as { code?: number }).code ?? "?";
    throw new Error(`gh issue create failed (${code})`);
  }
}

// ---------------------------------------------------------------------------
// Review helpers — getAuthUser + getPrHead
// ---------------------------------------------------------------------------

/** Pure argv builder for `gh api user --jq .login` (exported for unit tests). */
export function buildGhArgs_getAuthUser(): string[] {
  return ["api", "user", "--jq", ".login"];
}

/** Pure argv builder for `gh api repos/<slug>/pulls/<N> --jq ...` (exported for unit tests). */
export function buildGhArgs_getPrHead(slug: string, pr: number): string[] {
  return ["api", `repos/${slug}/pulls/${pr}`, "--jq", "{sha:.head.sha,base:.base.ref,baseSha:.base.sha,title:.title,body:.body,updatedAt:.updated_at}"];
}

export function buildGhArgs_getApprovalProtection(slug: string, branch: string): string[] {
  return ["api", `repos/${slug}/branches/${branch}/protection`, "--jq", "{dismissStale:.required_pull_request_reviews.dismiss_stale_reviews,requireLastPush:.required_pull_request_reviews.require_last_push_approval}"];
}

/**
 * Active branch rules (Rules API). Unlike the classic protection endpoint —
 * which is ADMIN-only and 404s for the read-only pinned review identity —
 * this is readable by anyone with read access, so it is the primary
 * approval-readiness probe (#90). Note: classic branch-protection settings do
 * NOT surface here (verified empirically); only rulesets do.
 */
export function buildGhArgs_getBranchRules(slug: string, branch: string): string[] {
  return ["api", `repos/${slug}/rules/branches/${branch}`, "--jq",
    '[.[] | select(.type == "pull_request") | {dismissStale: .parameters.dismiss_stale_reviews_on_push, requireLastPush: .parameters.require_last_push_approval}]'];
}

export function buildGhArgs_createPullRequestApproval(args: {
  slug: string; pr: number; commitId: string; body: string;
}): string[] {
  return [
    "api", "--method", "POST", `repos/${args.slug}/pulls/${args.pr}/reviews`,
    "-f", "event=APPROVE", "-f", `commit_id=${args.commitId}`, "-f", `body=${args.body}`,
  ];
}

export function buildGhArgs_hasPullRequestApproval(args: { slug: string; pr: number; commitId: string; artifactSha256: string; actor: string }): string[] {
  return ["api", "--paginate", `repos/${args.slug}/pulls/${args.pr}/reviews`, "--jq",
    `.[] | select(.state == \"APPROVED\" and .commit_id == \"${args.commitId}\" and .user.login == \"${args.actor}\" and (.body // \"\" | contains(\"${args.artifactSha256}\"))) | .id`];
}

export async function hasPullRequestApproval(
  args: { slug: string; pr: number; commitId: string; artifactSha256: string; actor: string; token?: string },
  deps: GithubDeps = {},
): Promise<boolean | undefined> {
  const exec = deps.exec ?? defaultExec;
  const gh = (deps.findBinary ?? findGhBinary)();
  if (!gh || !/^[0-9a-f]{40}$/i.test(args.commitId) || !/^[0-9a-f]{64}$/i.test(args.artifactSha256) || !/^[A-Za-z0-9-]+$/.test(args.actor)) return undefined;
  try {
    const env = args.token ? { ...process.env, GH_TOKEN: args.token } : process.env;
    const { stdout } = await exec(gh, buildGhArgs_hasPullRequestApproval(args), { env, timeoutMs: 15_000 });
    return stdout.trim().length > 0;
  } catch {
    return undefined;
  }
}

export async function approvalProtectionReady(
  args: { slug: string; branch: string; token?: string },
  deps: GithubDeps = {},
): Promise<boolean> {
  const exec = deps.exec ?? defaultExec;
  const gh = (deps.findBinary ?? findGhBinary)();
  if (!gh) return false;
  const env = args.token ? { ...process.env, GH_TOKEN: args.token } : process.env;
  // Require both controls (dismiss-stale + require-last-push). This is
  // stronger than either setting alone and avoids treating a client-side
  // head GET as a compare-and-set operation.
  //
  // Probe order (#90): the Rules API first — it is readable with plain read
  // access, which the pinned review identity has; the classic protection
  // endpoint is ADMIN-only and permanently 404s for that identity, so it can
  // only ever help as a fallback when the token happens to be an admin's.
  try {
    const { stdout } = await exec(gh, buildGhArgs_getBranchRules(args.slug, args.branch), { env, timeoutMs: 15_000 });
    const rules = JSON.parse(stdout) as Array<{ dismissStale?: boolean; requireLastPush?: boolean }>;
    if (rules.some((r) => r.dismissStale === true && r.requireLastPush === true)) return true;
  } catch {
    /* rules unreadable (very old GH / plan limits) — try classic below */
  }
  try {
    const { stdout } = await exec(gh, buildGhArgs_getApprovalProtection(args.slug, args.branch), { env, timeoutMs: 15_000 });
    const protection = JSON.parse(stdout) as { dismissStale?: boolean; requireLastPush?: boolean };
    return protection.dismissStale === true && protection.requireLastPush === true;
  } catch {
    return false;
  }
}

/**
 * Argv: read every active pull_request rule's required_approving_review_count
 * from the Rules API (same endpoint as buildGhArgs_getBranchRules, readable by
 * the read-only pinned identity). An empty array = no pull_request rule = no gate.
 */
export function buildGhArgs_getReviewGate(slug: string, branch: string): string[] {
  return ["api", `repos/${slug}/rules/branches/${branch}`, "--jq",
    '[.[] | select(.type == "pull_request") | .parameters.required_approving_review_count]'];
}

/**
 * True only for a literal HTTP 404 from the Rules API, read off the failed
 * process rather than the Error message: `gh` exits 1 with the API body on
 * stdout and a summary on stderr. Deliberately narrow — 401/403/5xx and
 * transport errors must NOT match, because "cannot see the protection" is not
 * "there is no protection". Never inspects `err.message`, which callers and
 * tests may set to arbitrary text.
 */
function isRulesApiNotFound(err: unknown): boolean {
  const e = err as { stderr?: unknown; stdout?: unknown };
  const streams = [e?.stderr, e?.stdout]
    .filter((s): s is string => typeof s === "string")
    .join("\n");
  if (!streams) return false;
  return /\(HTTP 404\)|"status"\s*:\s*"?404"?/.test(streams);
}

/**
 * Three-state review-gate probe for the ungated auto-allow path.
 *   true      → gated (some ruleset requires >=1 approving review)
 *   false     → ungated (no pull_request rule, count 0/absent, or the branch
 *               has no ruleset at all — which the Rules API reports as 404
 *               rather than an empty array)
 *   undefined → unknown (no gh, or the Rules API is unreadable)
 * The undefined state is load-bearing: the caller allows ONLY on a literal
 * false, and fails closed on undefined. Classic (admin-only) branch protection
 * does not surface here — the org is rulesets-only, so an empty result is a
 * genuine "no gate" (see the design doc's accepted-risk section).
 */
export async function reviewGateStatus(
  args: { slug: string; branch: string; token?: string },
  deps: GithubDeps = {},
): Promise<boolean | undefined> {
  const exec = deps.exec ?? defaultExec;
  const gh = (deps.findBinary ?? findGhBinary)();
  if (!gh) return undefined;
  const env = args.token ? { ...process.env, GH_TOKEN: args.token } : process.env;
  try {
    const { stdout } = await exec(gh, buildGhArgs_getReviewGate(args.slug, args.branch), { env, timeoutMs: 15_000 });
    const counts = JSON.parse(stdout) as Array<number | null>;
    return counts.some((c) => typeof c === "number" && c >= 1);
  } catch (err) {
    // A branch with no ruleset 404s instead of returning []. That is the same
    // "no pull_request rule" fact an empty array expresses, so report it as
    // ungated. Every other failure stays unknown and the caller fails closed.
    if (isRulesApiNotFound(err)) return false;
    return undefined;
  }
}

export interface PullRequestApprovalResult {
  reviewId: number;
  state: string;
  commitId: string;
  actor?: string;
  htmlUrl?: string;
}

export interface PullRequestReviewFinding {
  path: string;
  line: number;
  body: string;
  severity?: string;
}

export async function createPullRequestReview(
  args: {
    slug: string; pr: number; commitId: string; body: string;
    event: "COMMENT" | "REQUEST_CHANGES"; comments: PullRequestReviewFinding[]; token?: string;
  },
  deps: GithubDeps = {},
): Promise<PullRequestApprovalResult> {
  const exec = deps.exec ?? defaultExec;
  const gh = (deps.findBinary ?? findGhBinary)();
  if (!gh) throw new Error("gh is unavailable");
  const dir = mkdtempSync(path.join(os.tmpdir(), "pmk-gh-review-"));
  const input = path.join(dir, "review.json");
  writeFileSync(input, JSON.stringify({
    commit_id: args.commitId,
    event: args.event,
    body: args.body,
    comments: args.comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: c.severity ? `[${c.severity}] ${c.body}` : c.body })),
  }), { mode: 0o600 });
  try {
    const env = args.token ? { ...process.env, GH_TOKEN: args.token } : process.env;
    const { stdout } = await exec(gh, ["api", "--method", "POST", `repos/${args.slug}/pulls/${args.pr}/reviews`, "--input", input], { env, timeoutMs: 30_000 });
    const review = JSON.parse(stdout) as { id?: number; state?: string; commit_id?: string; user?: { login?: string }; html_url?: string };
    if (!review.id || !review.state || review.commit_id !== args.commitId)
      throw new Error("GitHub returned an invalid review response");
    return { reviewId: review.id, state: review.state, commitId: review.commit_id, actor: review.user?.login, htmlUrl: review.html_url };
  } catch (err) {
    const code = (err as { code?: number }).code ?? "?";
    throw new Error(`GitHub review post failed (${code})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function createPullRequestApproval(
  args: { slug: string; pr: number; commitId: string; body: string; token?: string },
  deps: GithubDeps = {},
): Promise<PullRequestApprovalResult> {
  const exec = deps.exec ?? defaultExec;
  const gh = (deps.findBinary ?? findGhBinary)();
  if (!gh) throw new Error("gh is unavailable");
  try {
    const env = args.token ? { ...process.env, GH_TOKEN: args.token } : process.env;
    const { stdout } = await exec(gh, buildGhArgs_createPullRequestApproval(args), { env, timeoutMs: 30_000 });
    const review = JSON.parse(stdout) as {
      id?: number; state?: string; commit_id?: string; user?: { login?: string }; html_url?: string;
    };
    if (!review.id || review.state?.toUpperCase() !== "APPROVED" || review.commit_id !== args.commitId)
      throw new Error("GitHub returned an invalid approval response");
    return { reviewId: review.id, state: review.state, commitId: review.commit_id, actor: review.user?.login, htmlUrl: review.html_url };
  } catch (err) {
    const code = (err as { code?: number }).code ?? "?";
    throw new Error(`GitHub approval result is unknown (${code})`);
  }
}

/**
 * Returns the authenticated GitHub login for the given token, or undefined on
 * any failure. No-leak: errors are swallowed, never logged or rethrown.
 */
export async function getAuthUser(
  opts: { token?: string } = {},
  deps: GithubDeps = {},
): Promise<string | undefined> {
  const exec = deps.exec ?? defaultExec;
  const findBinary = deps.findBinary ?? findGhBinary;
  const gh = findBinary();
  if (!gh) return undefined;
  try {
    const env = opts.token ? { ...process.env, GH_TOKEN: opts.token } : process.env;
    const { stdout } = await exec(gh, buildGhArgs_getAuthUser(), { env, timeoutMs: 15_000 });
    const login = stdout.trim();
    return login || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns `{ sha, baseRef }` for the given PR, or undefined on any failure.
 * No-leak: errors are swallowed, never logged or rethrown.
 */
export async function getPrHead(
  args: { slug: string; pr: number; token?: string },
  deps: GithubDeps = {},
): Promise<{ sha: string; baseRef: string; baseSha?: string; title?: string; body?: string; updatedAt?: string } | undefined> {
  const exec = deps.exec ?? defaultExec;
  const findBinary = deps.findBinary ?? findGhBinary;
  const gh = findBinary();
  if (!gh) return undefined;
  try {
    const env = args.token ? { ...process.env, GH_TOKEN: args.token } : process.env;
    const { stdout } = await exec(gh, buildGhArgs_getPrHead(args.slug, args.pr), {
      env,
      timeoutMs: 15_000,
    });
    const obj = JSON.parse(stdout) as { sha?: string; base?: string; baseSha?: string; title?: string; body?: string; updatedAt?: string };
    if (!obj.sha || !obj.base) return undefined;
    return { sha: obj.sha, baseRef: obj.base, baseSha: obj.baseSha, title: obj.title, body: obj.body, updatedAt: obj.updatedAt };
  } catch {
    return undefined;
  }
}

/** Doctor check: gh present + token non-empty. Never prints the token. */
export async function githubDoctor(
  args: { token: string | undefined },
  deps: GithubDeps = {},
): Promise<{ ok: boolean; reason?: string }> {
  const findBinary = deps.findBinary ?? findGhBinary;
  const gh = findBinary();
  if (!gh) return { ok: false, reason: "gh CLI not found on PATH" };
  if (!args.token) return { ok: false, reason: "github.token unset / unresolved" };
  const exec = deps.exec ?? defaultExec;
  try {
    await exec(gh, ["auth", "status", "--hostname", "github.com"], {
      env: { ...process.env, GH_TOKEN: args.token },
      timeoutMs: 10_000,
    });
    return { ok: true };
  } catch {
    return { ok: false, reason: "gh auth status failed for the provided token" };
  }
}
