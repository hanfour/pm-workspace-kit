/**
 * Thin adapter over the user's local `mra` (multi-repo-agent) install.
 * Encapsulates everything pmk needs to know about mra so the rest of
 * the CLI stays unaware of mra's CLI surface.
 *
 * Decision: ADR-0005 — pmk delegates code intelligence to mra.
 *
 * Layout (verified against mra v2.2.0+, lib/init.sh + lib/pkb.sh):
 *   - workspace marker: `<workspace>/.collab/repos.json`
 *   - per-repo PKB:     `<workspace>/<repo>/.mra/pkb/`
 *   - PKB doc set:      sitemap.md, architecture.md, conventions.md,
 *                       api-surface.md (no identity.md — earlier brief
 *                       was wrong)
 *   - mra has no `--version` flag; existence + workspace marker is
 *     the proxy for "install looks healthy".
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Documents pmk pulls when ingesting `mra:<repo>`. Aligned to mra's
 * actual PKB layout (see lib/pkb.sh::PKB_DIR_NAME=".mra/pkb").
 */
export const PKB_BASE_DOCS = [
  "sitemap.md",
  "architecture.md",
  "conventions.md",
  "api-surface.md",
] as const;

/** Subpath inside each repo where PKB summaries live. */
export const PKB_DIR_RELATIVE = path.join(".mra", "pkb");

/** File mra creates at `mra init`; presence = workspace root. */
const WORKSPACE_MARKER_PRIMARY = path.join(".collab", "repos.json");

/** Older / alternate markers we still detect for forward-compat. */
const WORKSPACE_MARKER_FALLBACKS = [
  ".collab",
  ".mra-config",
  "mra-workspace.json",
];

export interface MraDoctorReport {
  ok: boolean;
  binaryPath?: string;
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
 *
 * Note: many users alias `mra` as a shell function pointing at
 * `~/multi-repo-agent/bin/mra.sh`. `which mra` won't see shell
 * functions from non-interactive shells, so the fs fallback list
 * includes that canonical path.
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
 * Walk up from `start` looking for a directory that holds an mra
 * workspace. Primary signal is `.collab/repos.json` (what `mra init`
 * creates); fallbacks accept just the `.collab` dir or older marker
 * files for forward-compat.
 */
export function findMraWorkspace(
  start: string = process.cwd(),
): string | undefined {
  let cur = path.resolve(start);
  while (true) {
    if (existsSync(path.join(cur, WORKSPACE_MARKER_PRIMARY))) return cur;
    for (const m of WORKSPACE_MARKER_FALLBACKS) {
      if (existsSync(path.join(cur, m))) return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

/**
 * Pre-flight check used by both explore and ingest mra:. Returns a
 * structured report so callers can format error UX consistently.
 *
 * mra has no `--version` flag, so we don't claim a version. A future
 * mra release may add one — adapter will pick it up then.
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
  const workspace = findMraWorkspace(opts.cwd);
  if (!workspace) {
    return {
      ok: false,
      binaryPath,
      reason:
        "no mra workspace detected here. Run `mra init <dir>` then come back.",
    };
  }
  return { ok: true, binaryPath, workspace };
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
 * Load the base PKB summaries from a repo. Missing files are
 * skipped (caller decides whether that's an error). Each entry
 * carries mtime so callers can warn about staleness.
 */
export function loadPkbBase(repoPath: string): PkbDoc[] {
  const pkbDir = path.join(repoPath, PKB_DIR_RELATIVE);
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
 *
 * Per `mra --help`, "mra <command|project...>" makes a bare project
 * name a valid invocation that triggers `launch_claude` with the
 * project context. `--with-deps` extends to upstream/downstream repos.
 */
export function buildExploreArgv(repo: string): string[] {
  return [repo, "--with-deps"];
}

export interface MraAskResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  reason?: string;
}

/**
 * Run `mra ask <repo> "<question>"` as a subprocess. Used by the
 * gateway when the LLM emits an `mra-ask` directive — pmk delegates
 * the deep code-search round to mra and feeds the answer back into
 * the next LLM turn.
 *
 * The mra binary is resolved via findMraBinary() so users with a
 * shell-function alias still work (PATH won't see those, but the fs
 * fallback list does).
 *
 * Timeout defaults to 120s — `mra ask` involves an embedded LLM call
 * over the repo, which routinely takes 30–60s.
 */
export async function runMraAsk(args: {
  repo: string;
  question: string;
  cwd: string;
  timeoutMs?: number;
}): Promise<MraAskResult> {
  const binary = findMraBinary();
  if (!binary) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      reason: "`mra` binary not found on PATH",
    };
  }
  const timeoutMs = args.timeoutMs ?? 120_000;
  return await new Promise<MraAskResult>((resolve) => {
    const child = execFile(
      binary,
      ["ask", args.repo, args.question],
      {
        cwd: args.cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10 MiB
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        if (err) {
          const killed = (err as NodeJS.ErrnoException).code === "ETIMEDOUT";
          resolve({
            ok: false,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            reason: killed
              ? `mra ask timed out after ${timeoutMs}ms`
              : err.message,
          });
          return;
        }
        resolve({
          ok: true,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
    child.on("error", (err) => {
      resolve({
        ok: false,
        stdout: "",
        stderr: "",
        reason: err.message,
      });
    });
  });
}

interface ReposJson {
  repos: Array<{ name: string; archived?: boolean; clone?: boolean }>;
}

/**
 * Read `<workspace>/.collab/repos.json` and return the names of every
 * repo that (a) is not archived and (b) has a `.mra/pkb/` directory
 * with at least one base doc. Returns empty if the file or workspace
 * is missing.
 *
 * Used by `pmk ingest mra:--all` to pick the load set without forcing
 * the user to enumerate 27 repo names.
 */
export function listMraWorkspaceReposWithPkb(workspace: string): string[] {
  const reposJson = path.join(workspace, ".collab", "repos.json");
  if (!existsSync(reposJson)) return [];
  let manifest: ReposJson;
  try {
    manifest = JSON.parse(readFileSync(reposJson, "utf8")) as ReposJson;
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const r of manifest.repos ?? []) {
    if (r.archived) continue;
    const repoPath = path.join(workspace, r.name);
    if (!existsSync(repoPath)) continue;
    if (loadPkbBase(repoPath).length > 0) out.push(r.name);
  }
  return out;
}
