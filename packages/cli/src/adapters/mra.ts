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
 * Resolution order for the workspace:
 *   1. `opts.workspace` if provided AND it actually contains the
 *      marker file. This is what gateway uses (`cfg.mraWorkspace`)
 *      so `pmk gateway start` can be launched from any cwd.
 *   2. Walk up from `opts.cwd` (or process.cwd) looking for the
 *      marker — original v0.7.0 behaviour, kept as fallback.
 *
 * mra has no `--version` flag, so we don't claim a version. A future
 * mra release may add one — adapter will pick it up then.
 */
export function mraDoctor(
  opts: { cwd?: string; workspace?: string } = {},
): MraDoctorReport {
  const binaryPath = findMraBinary();
  if (!binaryPath) {
    return {
      ok: false,
      reason:
        "`mra` not found on PATH. Install: https://github.com/hanfour/multi-repo-agent#quick-start",
    };
  }
  // Explicit override wins, but only if it actually looks like an mra
  // workspace — otherwise we fall back to the cwd walk so a stale
  // config field doesn't silently break a host that has a valid
  // workspace ancestor.
  if (opts.workspace) {
    const explicit = path.resolve(opts.workspace);
    if (existsSync(path.join(explicit, WORKSPACE_MARKER_PRIMARY))) {
      return { ok: true, binaryPath, workspace: explicit };
    }
    return {
      ok: false,
      binaryPath,
      reason: `configured mraWorkspace '${opts.workspace}' has no .collab/repos.json. Run \`mra init\` there or update gateway.json.`,
    };
  }
  const workspace = findMraWorkspace(opts.cwd);
  if (!workspace) {
    return {
      ok: false,
      binaryPath,
      reason:
        "no mra workspace detected. Set `mraWorkspace` in ~/.pmk/gateway.json (or run `pmk gateway init` again) so pmk knows where your mra repos live.",
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
  /** How many subprocess attempts were made (1 = no retry). */
  attempts: number;
}

/**
 * Heuristic for "this looks transient enough to retry once". Live
 * dogfood (2026-04-28) saw `mra ask` return `Command failed: <argv>`
 * with **empty stderr** while a manual retry succeeded — the kind of
 * non-deterministic flake worth one retry. Excluded:
 *
 *   - timeouts (the next try will likely also time out)
 *   - explicit stderr (mra clearly reported a problem; not transient)
 *   - binary-not-found (won't suddenly appear)
 */
function looksTransient(result: MraAskResult): boolean {
  if (!result.reason) return false;
  if (result.reason.includes("not found on PATH")) return false;
  if (result.reason.includes("timed out")) return false;
  if (result.stderr.trim().length > 0) return false;
  return true;
}

interface RunMraAskOpts {
  /** Max retries on transient failures (default 1 = at most one extra try). */
  maxRetries?: number;
  /** Optional progress callback fired before each retry. */
  onRetry?: (attempt: number, prevResult: MraAskResult) => void;
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
 *
 * Retries: on a transient-looking failure (see {@link looksTransient}),
 * this function silently retries once. The returned `attempts` field
 * lets callers see whether a retry happened.
 */
export async function runMraAsk(
  args: {
    repo: string;
    question: string;
    cwd: string;
    timeoutMs?: number;
  },
  opts: RunMraAskOpts = {},
): Promise<MraAskResult> {
  const binary = findMraBinary();
  if (!binary) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      reason: "`mra` binary not found on PATH",
      attempts: 1,
    };
  }
  const maxRetries = opts.maxRetries ?? 1;
  // 300s default — bumped from 120s in v0.7.5. Live dogfood (2026-04-28)
  // showed a complex multi-clause CJK question took 160s of mra-internal
  // LLM time, so the v0.7.0 cap of 120s was killing legitimate queries
  // mid-flight. 300s gives ~2× headroom for the worst we've observed.
  const timeoutMs = args.timeoutMs ?? 300_000;
  let last: MraAskResult | undefined;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const result = await runMraAskOnce(binary, args, timeoutMs);
    if (result.ok || !looksTransient(result) || attempt > maxRetries) {
      return { ...result, attempts: attempt };
    }
    last = result;
    opts.onRetry?.(attempt, result);
  }
  // Unreachable in practice but appeases the type checker.
  return { ...(last as MraAskResult), attempts: maxRetries + 1 };
}

function runMraAskOnce(
  binary: string,
  args: { repo: string; question: string; cwd: string },
  timeoutMs: number,
): Promise<MraAskResult> {
  return new Promise<MraAskResult>((resolve) => {
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
          // execFile's timeout sends SIGTERM (the configured killSignal,
          // which defaults to SIGTERM). Node populates `err.killed` and
          // `err.signal` on the resulting error. The earlier
          // `code === "ETIMEDOUT"` check basically never fired — Node's
          // signaled-kill path sets `code: null`, so timeouts were
          // mis-classified as "Command failed" generic errors and
          // (worse) looksTransient would retry them. Detecting via
          // `killed`/`signal` is what the docs actually describe.
          const errAny = err as NodeJS.ErrnoException & {
            killed?: boolean;
            signal?: string;
          };
          const isTimeout =
            errAny.killed === true ||
            errAny.signal === "SIGTERM" ||
            errAny.code === "ETIMEDOUT";
          resolve({
            ok: false,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            reason: isTimeout
              ? `mra ask timed out after ${timeoutMs}ms`
              : err.message,
            attempts: 1,
          });
          return;
        }
        resolve({
          ok: true,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          attempts: 1,
        });
      },
    );
    child.on("error", (err) => {
      resolve({
        ok: false,
        stdout: "",
        stderr: "",
        reason: err.message,
        attempts: 1,
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
