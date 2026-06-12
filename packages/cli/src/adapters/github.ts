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
import { existsSync } from "node:fs";
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
}

const defaultExec: GithubExec = async (file, args, opts) => {
  const { stdout } = await execFileAsync(file, args, {
    env: opts.env,
    timeout: opts.timeoutMs,
    encoding: "utf8",
  });
  return { stdout: stdout.toString() };
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
  return segs.every((s) => s.length > 0 && s !== ".." && SAFE_SEGMENT.test(s));
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
  args: { slug: string; token: string },
  deps: GithubDeps = {},
): Promise<"public" | "private" | "unknown"> {
  const exec = deps.exec ?? defaultExec;
  const gh = findGhBinary() ?? "gh";
  try {
    const { stdout } = await exec(
      gh,
      ["repo", "view", args.slug, "--json", "visibility", "-q", ".visibility"],
      { env: { ...process.env, GH_TOKEN: args.token }, timeoutMs: 15_000 },
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
  const gh = findGhBinary() ?? "gh";
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

/** Doctor check: gh present + token non-empty. Never prints the token. */
export async function githubDoctor(
  args: { token: string | undefined },
  deps: GithubDeps = {},
): Promise<{ ok: boolean; reason?: string }> {
  if (!findGhBinary()) return { ok: false, reason: "gh CLI not found on PATH" };
  if (!args.token) return { ok: false, reason: "github.token unset / unresolved" };
  // exit-code-only auth probe; discard stdout/stderr so the authed
  // username / scopes never reach a log.
  const exec = deps.exec ?? defaultExec;
  const gh = findGhBinary() ?? "gh";
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
