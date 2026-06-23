/**
 * Prepare an ISOLATED checkout of a PR head for `mra review --pr`, in a
 * gateway-owned parallel workspace (never the operator's working clone). Uses
 * the real project NAME (so mra's dep-graph/consumer analysis works) by copying
 * .collab metadata; reference-clones to share the object store; physically
 * copies PKB (symlink would pollute the source clone via mra's writeback).
 * Verified constraints: project-path.sh (name must be workspace-contained),
 * review.sh (diff is local base...HEAD; HEAD must be the PR head).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
    env: env ?? process.env,
  }).toString().trim();
}

/**
 * Git env that authenticates github.com clone/fetch with a PINNED token via
 * `http.extraheader`, injected through GIT_CONFIG_* env vars (NOT process args,
 * so the token never appears in `ps`). This overrides the host's git credential
 * helper / active `gh` account — so clone+fetch use the SAME stable identity as
 * the `gh` POST, independent of which gh account is currently active. Without a
 * token, returns the ambient env unchanged. (Live-found 2026-06-23: a fresh
 * clone failed "Repository not found" because git used the active gh account,
 * which had flipped to one without access to the private repo.)
 */
function gitAuthEnv(token?: string): NodeJS.ProcessEnv {
  if (!token) return process.env;
  const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${auth}`,
  };
}

/**
 * Copy the workspace-level .collab metadata (repos.json, dep-graph.json) from
 * the operator's main workspace into the gateway-owned review workspace so
 * `mra review` runs under the real project name with consumer/dep-graph context.
 *
 * Best-effort by design: a missing source file is intentionally skipped, not an
 * error. `mra review` tolerates an absent dep-graph.json (it guards it with
 * `[[ -f ]]`), so absence merely drops cross-project consumer analysis rather
 * than failing the review. Overwrites on each prepare to stay fresh.
 */
export function ensureReviewWorkspaceMeta(mainWorkspace: string, reviewWorkspace: string): void {
  const dst = path.join(reviewWorkspace, ".collab");
  fs.mkdirSync(dst, { recursive: true });
  for (const f of ["repos.json", "dep-graph.json"]) {
    const src = path.join(mainWorkspace, ".collab", f);
    // best-effort: skip silently if the source file isn't present (see contract above)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dst, f));
  }
}

export function teardownReviewClone(args: { reviewWorkspace: string; project: string }): void {
  const dir = path.join(args.reviewWorkspace, args.project);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

export async function prepareReviewClone(args: {
  mainClone: string; reviewWorkspace: string; project: string;
  slug: string; pr: number; expectedHeadSha: string; baseRef: string;
  /** Pinned token for git clone/fetch auth (via http.extraheader). Undefined → ambient git creds. */
  ghToken?: string;
}): Promise<{ ok: true; cloneDir: string; baseRef: string } | { ok: false; reason: string }> {
  const cloneDir = path.join(args.reviewWorkspace, args.project);
  // Authenticate clone+fetch with the pinned token so they don't depend on the
  // host's active gh account (git's credential helper otherwise uses it).
  const env = gitAuthEnv(args.ghToken);
  try {
    const originUrl = git(args.mainClone, ["remote", "get-url", "origin"]);
    if (!fs.existsSync(cloneDir)) {
      // --reference shares the object store with the main clone (cheap). Per Task 0
      // spike: switch to a plain `git clone <originUrl> <cloneDir>` if --reference is unsafe.
      execFileSync("git", ["clone", "--reference", args.mainClone, originUrl, cloneDir],
        { stdio: ["ignore", "pipe", "pipe"], env });
    }
    git(cloneDir, ["fetch", "origin", `pull/${args.pr}/head`], env);
    git(cloneDir, ["checkout", "--detach", "FETCH_HEAD"]);
    const head = git(cloneDir, ["rev-parse", "HEAD"]);
    if (head !== args.expectedHeadSha) {
      return { ok: false, reason: `head-mismatch: local ${head.slice(0, 8)} != pr ${args.expectedHeadSha.slice(0, 8)}` };
    }
    // physical PKB copy (NEVER symlink — mra writes back post-review)
    const pkbSrc = path.join(args.mainClone, ".mra", "pkb");
    if (fs.existsSync(pkbSrc)) {
      const pkbDst = path.join(cloneDir, ".mra", "pkb");
      fs.rmSync(pkbDst, { recursive: true, force: true });
      fs.cpSync(pkbSrc, pkbDst, { recursive: true });
    }
    const diff = git(cloneDir, ["diff", `${args.baseRef}...HEAD`, "--name-only"]);
    if (!diff.trim()) return { ok: false, reason: "empty-diff" };
    return { ok: true, cloneDir, baseRef: args.baseRef };
  } catch (err) {
    return { ok: false, reason: `prepare-failed: ${(err as Error).message}` };
  }
}
