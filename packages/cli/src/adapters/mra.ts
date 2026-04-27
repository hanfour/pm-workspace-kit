/**
 * Thin adapter over the user's local `mra` (multi-repo-agent) install.
 * Encapsulates everything pmk needs to know about mra so the rest of
 * the CLI stays unaware of mra's CLI surface.
 *
 * Decision: ADR-0005 — pmk delegates code intelligence to mra.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Minimum mra version this adapter is known to work against. */
export const MIN_MRA_VERSION = "2.2.0";

/** PKB documents that ingest mra:<repo> always loads (Layer 0 + 1 + 2). */
export const PKB_BASE_DOCS = [
  "identity.md",
  "sitemap.md",
  "architecture.md",
  "api-surface.md",
] as const;

export interface MraDoctorReport {
  ok: boolean;
  binaryPath?: string;
  version?: string;
  workspace?: string;
  reason?: string;
}

const FALLBACK_BIN_PATHS: string[] =
  process.platform === "win32"
    ? []
    : [
        path.join(os.homedir(), ".local", "bin", "mra"),
        path.join(os.homedir(), "multi-repo-agent", "bin", "mra.sh"),
        "/opt/homebrew/bin/mra",
        "/usr/local/bin/mra",
      ];

/**
 * Locate the `mra` executable. PATH first, then known install
 * locations. Returns undefined when mra is not installed.
 */
export function findMraBinary(): string | undefined {
  if (process.env.PMK_SKIP_MRA_PROBE === "1") return undefined;
  try {
    const out = execFileSync(
      process.platform === "win32" ? "where" : "which",
      ["mra"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString()
      .trim();
    const first = out.split(/\r?\n/)[0];
    if (first) return first;
  } catch {
    /* fall through to fs probe */
  }
  for (const p of FALLBACK_BIN_PATHS) {
    try {
      if (existsSync(p) && statSync(p).isFile()) return p;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

/**
 * Walk up from `start` looking for a directory that contains a
 * `.mra-config` file (or an `mra-workspace.json` — both are valid in
 * mra's own conventions). Returns the workspace root or undefined.
 */
export function findMraWorkspace(start: string = process.cwd()): string | undefined {
  let cur = path.resolve(start);
  while (true) {
    if (existsSync(path.join(cur, ".mra-config"))) return cur;
    if (existsSync(path.join(cur, "mra-workspace.json"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

/**
 * Pre-flight check used by both explore and ingest mra:. Returns a
 * structured report so callers can format error UX consistently.
 */
export function mraDoctor(opts: { cwd?: string } = {}): MraDoctorReport {
  const binaryPath = findMraBinary();
  if (!binaryPath) {
    return {
      ok: false,
      reason:
        "`mra` not found on PATH. Install: https://github.com/hanfour/multi-repo-agent#quick-start",
    };
  }
  let version: string | undefined;
  try {
    version = execFileSync(binaryPath, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return {
      ok: false,
      binaryPath,
      reason: `\`${binaryPath} --version\` failed — install may be broken.`,
    };
  }

  const workspace = findMraWorkspace(opts.cwd);
  if (!workspace) {
    return {
      ok: false,
      binaryPath,
      version,
      reason:
        "no mra workspace detected here. Run `mra init <dir>` then come back.",
    };
  }
  return { ok: true, binaryPath, version, workspace };
}

/**
 * Resolve a repo identifier within the current mra workspace. Accepts
 * either a bare name (`erp/order` → `<workspace>/erp/order`) or an
 * absolute path. Returns the resolved absolute path or undefined if
 * the directory doesn't exist.
 */
export function resolveMraRepo(
  workspace: string,
  repo: string,
): string | undefined {
  const abs = path.isAbsolute(repo) ? repo : path.join(workspace, repo);
  if (!existsSync(abs)) return undefined;
  if (!statSync(abs).isDirectory()) return undefined;
  return abs;
}

export interface PkbDoc {
  name: string;
  path: string;
  content: string;
  mtime: number;
}

/**
 * Load the four base PKB summaries from a repo. Missing files are
 * skipped (caller decides whether that's an error). Each entry
 * carries mtime so callers can warn about staleness.
 */
export function loadPkbBase(repoPath: string): PkbDoc[] {
  const pkbDir = path.join(repoPath, ".collab", "pkb");
  if (!existsSync(pkbDir)) return [];
  const out: PkbDoc[] = [];
  for (const name of PKB_BASE_DOCS) {
    const file = path.join(pkbDir, name);
    if (!existsSync(file)) continue;
    try {
      const stat = statSync(file);
      out.push({
        name,
        path: file,
        content: readFileSync(file, "utf8"),
        mtime: stat.mtimeMs,
      });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

/**
 * Build the argv for `mra <repo> --with-deps`. Centralised so the
 * explore command doesn't hard-code the flag.
 */
export function buildExploreArgv(repo: string): string[] {
  return [repo, "--with-deps"];
}
