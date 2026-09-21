import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertSafeBranch } from "../../commands/worktree";

/** Entry point of the CLI inside an exported release. */
export const ENTRY_RELATIVE = path.join("packages", "cli", "dist", "index.js");
export const RELEASE_INFO_FILE = "RELEASE.json";

export type ReleaseLink = "current" | "previous";

export interface ReleaseInfo {
  ref: string;
  sha: string;
  version: string;
  builtAt: string;
  nodeVersion: string;
}

const SHORT_SHA_LENGTH = 7;
const RELEASE_NAME_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]*-[0-9a-f]{7}$/;

export function releasesRoot(home: string = os.homedir()): string {
  return path.join(home, ".pmk", "releases");
}

export function releaseName(version: string, sha: string): string {
  return `${version}-${sha.slice(0, SHORT_SHA_LENGTH)}`;
}

/**
 * A release name becomes a directory under the releases root and a symlink
 * target, so it must not be able to climb out of the root or pose as a flag.
 */
export function assertSafeReleaseName(name: string): void {
  if (!RELEASE_NAME_RE.test(name) || name.includes("..")) {
    throw new Error(`invalid release name: ${name || "(empty)"}`);
  }
}

/** Same character rules as branch names: the ref is passed to git via execFile. */
export function assertSafeRef(ref: string): void {
  assertSafeBranch(ref);
}

export function releaseDir(root: string, name: string): string {
  assertSafeReleaseName(name);
  return path.join(root, name);
}

export function stagingDir(root: string, sha: string): string {
  return path.join(root, `.staging-${sha.slice(0, SHORT_SHA_LENGTH)}`);
}

/** The path the LaunchAgent runs. Fixed; only the `current` link moves. */
export function currentEntry(root: string): string {
  return path.join(root, "current", ENTRY_RELATIVE);
}

export function readLink(root: string, which: ReleaseLink): string | undefined {
  try {
    return path.basename(fs.readlinkSync(path.join(root, which)));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EINVAL") return undefined;
    throw e;
  }
}

/**
 * Point a link at a release with no intermediate state: build the new link
 * beside it, then rename over the old one. The target is relative so the
 * whole ~/.pmk tree can be moved without breaking the links.
 */
export function pointLink(root: string, which: ReleaseLink, name: string): void {
  assertSafeReleaseName(name);
  const tmp = path.join(root, `.${which}.tmp-${process.pid}`);
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(name, tmp);
  fs.renameSync(tmp, path.join(root, which));
}

export function removeLink(root: string, which: ReleaseLink): void {
  fs.rmSync(path.join(root, which), { force: true });
}

export function writeReleaseInfo(dir: string, info: ReleaseInfo): void {
  fs.writeFileSync(path.join(dir, RELEASE_INFO_FILE), `${JSON.stringify(info, null, 2)}\n`, "utf8");
}

export function readReleaseInfo(dir: string): ReleaseInfo | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, RELEASE_INFO_FILE), "utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const o = parsed as Record<string, unknown>;
    const fields = ["ref", "sha", "version", "builtAt", "nodeVersion"] as const;
    if (fields.some((f) => typeof o[f] !== "string")) return undefined;
    return { ref: o.ref, sha: o.sha, version: o.version, builtAt: o.builtAt, nodeVersion: o.nodeVersion } as ReleaseInfo;
  } catch {
    // Missing or unparseable: the directory is not a usable release.
    return undefined;
  }
}

/** Built releases, oldest first. A directory without RELEASE.json is not a release. */
export function listReleases(root: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return names
    .filter((n) => RELEASE_NAME_RE.test(n))
    .map((n) => ({ n, info: readReleaseInfo(path.join(root, n)) }))
    .filter((r): r is { n: string; info: ReleaseInfo } => r.info !== undefined)
    .sort((a, b) => a.info.builtAt.localeCompare(b.info.builtAt))
    .map((r) => r.n);
}

/** True when `dir` or any ancestor holds a `.git` entry. A `git archive` export never does. */
export function insideGitTree(dir: string): boolean {
  let at = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(at, ".git"))) return true;
    const parent = path.dirname(at);
    if (parent === at) return false;
    at = parent;
  }
}
