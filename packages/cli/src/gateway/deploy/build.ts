import * as fs from "node:fs";
import * as path from "node:path";
import {
  ENTRY_RELATIVE, RELEASE_INFO_FILE, assertSafeRef, releaseDir, releaseName, stagingDir, writeReleaseInfo,
} from "./paths";

export interface BuildDeps {
  /** Run a command and return its stdout. Throws on a non-zero exit. */
  run: (file: string, args: string[], cwd: string) => string;
  /** Write the tracked files of `sha` into `dest` (git archive | tar). */
  exportTree: (repo: string, sha: string, dest: string) => void;
  now: () => Date;
  nodeVersion: string;
  nodePath: string;
}

export interface BuildResult {
  name: string;
  dir: string;
  sha: string;
  version: string;
  reused: boolean;
}

/** Only what the gateway needs: skips docusaurus and electron (1.1 GB → ~300 MB). */
export const INSTALL_WORKSPACES = ["packages/cli", "packages/llm", "packages/rag", "packages/shared"] as const;
/** Same order as .github/workflows/test.yml — each one depends on the ones before it. */
export const BUILD_WORKSPACES = ["@pmk/shared", "@pmk/rag", "@pmk/llm", "@pmk/cli"] as const;

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

function resolveSha(repo: string, ref: string, d: BuildDeps): string {
  const sha = d.run("git", ["rev-parse", "--verify", `${ref}^{commit}`], repo).trim();
  if (!FULL_SHA_RE.test(sha)) throw new Error(`could not resolve ${ref} to a commit`);
  return sha;
}

function versionAt(repo: string, sha: string, d: BuildDeps): string {
  const parsed: unknown = JSON.parse(d.run("git", ["show", `${sha}:package.json`], repo));
  const version = (parsed as { version?: unknown } | null)?.version;
  if (typeof version !== "string" || version === "") {
    throw new Error(`package.json at ${sha} has no version`);
  }
  return version;
}

function installAndBuild(staging: string, d: BuildDeps): void {
  const scope = INSTALL_WORKSPACES.flatMap((w) => ["-w", w]);
  d.run("npm", ["ci", ...scope, "--no-audit", "--no-fund"], staging);
  for (const w of BUILD_WORKSPACES) d.run("npm", ["run", "build", `--workspace=${w}`], staging);
}

/**
 * `--version` proves the whole static import graph loads (index.ts imports
 * every command eagerly). `gateway status` additionally reads the operator's
 * config, read-only, and always exits 0 regardless of gateway health.
 * `gateway doctor` is not used: its verdict depends on the network right now.
 */
function smokeTest(staging: string, version: string, d: BuildDeps): void {
  const entry = path.join(staging, ENTRY_RELATIVE);
  const printed = d.run(d.nodePath, [entry, "--version"], staging).trim();
  if (printed !== version) {
    throw new Error(`smoke test: --version printed ${printed}, expected ${version}`);
  }
  d.run(d.nodePath, [entry, "gateway", "status"], staging);
}

export function buildRelease(a: { repo: string; ref: string; root: string }, d: BuildDeps): BuildResult {
  assertSafeRef(a.ref);
  const sha = resolveSha(a.repo, a.ref, d);
  const version = versionAt(a.repo, sha, d);
  const name = releaseName(version, sha);
  const dir = releaseDir(a.root, name);
  if (fs.existsSync(path.join(dir, RELEASE_INFO_FILE))) {
    return { name, dir, sha, version, reused: true };
  }

  const staging = stagingDir(a.root, sha);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    d.exportTree(a.repo, sha, staging);
    installAndBuild(staging, d);
    smokeTest(staging, version, d);
    writeReleaseInfo(staging, {
      ref: a.ref, sha, version, builtAt: d.now().toISOString(), nodeVersion: d.nodeVersion,
    });
    // A directory here without RELEASE.json is a leftover from an interrupted promote.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  return { name, dir, sha, version, reused: false };
}
