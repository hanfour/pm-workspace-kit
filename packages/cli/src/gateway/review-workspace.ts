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

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
  }).toString().trim();
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
}): Promise<{ ok: true; cloneDir: string; baseRef: string } | { ok: false; reason: string }> {
  const cloneDir = path.join(args.reviewWorkspace, args.project);
  try {
    const originUrl = git(args.mainClone, "remote", "get-url", "origin");
    if (!fs.existsSync(cloneDir)) {
      // --reference shares the object store with the main clone (cheap). Per Task 0
      // spike: switch to a plain `git clone <originUrl> <cloneDir>` if --reference is unsafe.
      execFileSync("git", ["clone", "--reference", args.mainClone, originUrl, cloneDir],
        { stdio: ["ignore", "pipe", "pipe"] });
    }
    git(cloneDir, "fetch", "origin", `pull/${args.pr}/head`);
    git(cloneDir, "checkout", "--detach", "FETCH_HEAD");
    const head = git(cloneDir, "rev-parse", "HEAD");
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
    const diff = git(cloneDir, "diff", `${args.baseRef}...HEAD`, "--name-only");
    if (!diff.trim()) return { ok: false, reason: "empty-diff" };
    return { ok: true, cloneDir, baseRef: args.baseRef };
  } catch (err) {
    return { ok: false, reason: `prepare-failed: ${(err as Error).message}` };
  }
}
