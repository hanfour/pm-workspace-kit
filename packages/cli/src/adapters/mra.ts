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

import type { PrDiscussionItem } from "./github";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
// Secret-stripping + pure review-protocol helpers live in sibling modules;
// imported for internal use and re-exported here for back-compat (callers and
// tests import them from "adapters/mra").
import { strippedChildEnv } from "./mra-env";
export { strippedChildEnv } from "./mra-env";
import {
  buildReviewArgv,
  parseReviewStdout,
  reviewEnv,
  type MraReviewResult,
  type ReviewStrategy,
  type ReviewProviderMode,
} from "./mra-review-protocol";
export {
  buildReviewArgv,
  parseReviewStdout,
  reviewEnv,
  type MraReviewResult,
  type ReviewStrategy,
  type ReviewProviderMode,
} from "./mra-review-protocol";

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

const reviewProviderCapability = new Map<string, boolean>();

export interface MraIntegrationCapabilities {
  protocolVersion: "1.0";
  capabilities: {
    analysisOnly: true;
    shaBinding: true;
    sanitizedContext: true;
    blockerUnion: true;
    resultArtifact: true;
  };
  providers: ["codex"];
}

const integrationCapabilityCache = new Map<string, { expiresAt: number; value?: MraIntegrationCapabilities }>();

function integrationCacheKey(binary: string): string {
  try {
    const real = realpathSync(binary);
    const st = statSync(real);
    return `${real}:${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return binary;
  }
}

export function mraIntegrationCapabilities(binary: string, fresh = false): MraIntegrationCapabilities | undefined {
  const key = integrationCacheKey(binary);
  const cached = integrationCapabilityCache.get(key);
  if (!fresh && cached && cached.expiresAt > Date.now()) return cached.value;
  let value: MraIntegrationCapabilities | undefined;
  try {
    const raw = execFileSync(binary, ["integration", "describe", "--json"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: strippedChildEnv(),
    });
    const parsed = JSON.parse(raw) as Partial<MraIntegrationCapabilities>;
    const c = parsed.capabilities;
    if (parsed.protocolVersion === "1.0" && c?.analysisOnly === true && c.shaBinding === true &&
        c.sanitizedContext === true && c.blockerUnion === true && c.resultArtifact === true &&
        Array.isArray(parsed.providers) && parsed.providers.length === 1 && parsed.providers[0] === "codex") {
      value = parsed as MraIntegrationCapabilities;
    }
  } catch { /* legacy or unavailable */ }
  integrationCapabilityCache.set(key, { expiresAt: Date.now() + 60_000, value });
  return value;
}

export function mraSupportsReviewProvider(binary: string): boolean {
  const cached = reviewProviderCapability.get(binary);
  if (cached !== undefined) return cached;
  let supported = false;
  try {
    const help = execFileSync(binary, ["--help"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    supported = /--provider\b/.test(help);
  } catch {
    supported = false;
  }
  reviewProviderCapability.set(binary, supported);
  return supported;
}

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
  // workspace ancestor. The startup pre-flight in gateway/index.ts
  // already surfaces a "stale mraWorkspace" warning to the operator,
  // so silent fall-back here is defense-in-depth, not data hiding.
  if (opts.workspace) {
    const explicit = path.resolve(opts.workspace);
    if (existsSync(path.join(explicit, WORKSPACE_MARKER_PRIMARY))) {
      return { ok: true, binaryPath, workspace: explicit };
    }
    // Fall through to cwd walk.
  }
  const workspace = findMraWorkspace(opts.cwd);
  if (!workspace) {
    return {
      ok: false,
      binaryPath,
      reason: opts.workspace
        ? `configured mraWorkspace '${opts.workspace}' has no .collab/repos.json, and cwd has no mra workspace ancestor either. Run \`mra init\` at the configured path or update gateway.json.`
        : "no mra workspace detected. Set `mraWorkspace` in ~/.pmk/gateway.json (or run `pmk gateway init` again) so pmk knows where your mra repos live.",
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

/**
 * Soft cap on captured mra stdout. Matches the old execFile maxBuffer
 * default (10 MiB). When exceeded, the child is SIGTERM'd and the
 * result returns ok=false with a reason mentioning the cap. Defence
 * in depth: mra runs are KB-scale in practice, but switching to
 * chunks + cap removes both the O(n²) string-concat risk and the
 * unbounded-memory risk in one lift.
 */
export const MAX_MRA_STDOUT_BYTES = 10 * 1024 * 1024;

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
  if (result.reason.includes("stdout exceeded")) return false;
  if (result.stderr.trim().length > 0) return false;
  return true;
}

interface RunMraAskOpts {
  /** Max retries on transient failures (default 1 = at most one extra try). */
  maxRetries?: number;
  /** Optional progress callback fired before each retry. */
  onRetry?: (attempt: number, prevResult: MraAskResult) => void;
  /**
   * Optional per-line stdout callback (v0.10 / #22). Fired for each
   * non-empty line as soon as it crosses the newline boundary —
   * caller is responsible for any throttling. Not fired for stderr.
   * `\r` is stripped; partial trailing lines (no terminating newline)
   * are not surfaced via this callback but DO appear in
   * {@link MraAskResult.stdout}. Errors thrown by the callback are
   * swallowed so a sink failure can't tear down the subprocess read.
   */
  onProgress?: (line: string) => void;
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
  return runMraAskWithBinary(binary, args, opts);
}

/**
 * Inner half of {@link runMraAsk} that takes an explicit binary path.
 * Exposed for testing — production callers should use runMraAsk so
 * the PATH probe and fallback list run the same way for everyone.
 */
export async function runMraAskWithBinary(
  binary: string,
  args: {
    repo: string;
    question: string;
    cwd: string;
    timeoutMs?: number;
  },
  opts: RunMraAskOpts = {},
): Promise<MraAskResult> {
  const maxRetries = opts.maxRetries ?? 1;
  // 300s default — bumped from 120s in v0.7.5. Live dogfood (2026-04-28)
  // showed a complex multi-clause CJK question took 160s of mra-internal
  // LLM time, so the v0.7.0 cap of 120s was killing legitimate queries
  // mid-flight. 300s gives ~2× headroom for the worst we've observed.
  const timeoutMs = args.timeoutMs ?? 300_000;
  let last: MraAskResult | undefined;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const result = await runMraAskOnce(binary, args, timeoutMs, opts);
    if (result.ok || !looksTransient(result) || attempt > maxRetries) {
      return { ...result, attempts: attempt };
    }
    last = result;
    opts.onRetry?.(attempt, result);
  }
  // Unreachable in practice but appeases the type checker.
  return { ...(last as MraAskResult), attempts: maxRetries + 1 };
}

/**
 * One subprocess invocation. Switched from `execFile` (buffered) to
 * `spawn` in v0.10 (#22) so callers can subscribe to a per-line
 * progress callback without losing the buffered stdout/stderr they
 * already depended on. Behaviour preservation:
 *
 *   - full stdout / stderr concatenated and returned
 *   - timeout via SIGTERM kill (matches execFile.killSignal default)
 *   - timeout-vs-error classification via {@link isTimeoutKill}
 *   - 'error' event resolves as a non-ok result with the error message
 *
 * Stdout is line-buffered: we accumulate chunks until we see `\n`,
 * then deliver complete lines (with `\r` stripped) to onProgress.
 * The trailing partial line at process exit is part of `result.stdout`
 * but is not surfaced via onProgress — most mra runs end with a
 * newline anyway, and a partial-line "progress" update is rarely
 * meaningful UX.
 */
function runMraAskOnce(
  binary: string,
  args: { repo: string; question: string; cwd: string },
  timeoutMs: number,
  opts: RunMraAskOpts,
): Promise<MraAskResult> {
  return new Promise<MraAskResult>((resolve) => {
    // Declared before settle so the catch block below can call settle
    // without tripping a TDZ ReferenceError when spawn throws
    // synchronously (e.g. NUL byte in binary path). clearTimeout
    // tolerates undefined per the Node API.
    let timeoutHandle: NodeJS.Timeout | undefined;
    let settled = false;
    const settle = (r: MraAskResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(r);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, ["ask", args.repo, args.question], {
        cwd: args.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        // The question is LLM-generated from untrusted chat and mra runs agents
        // over the repo, so strip secrets from the child env (mra self-auths via
        // its claude CLI). Same guard the review path already relies on.
        env: strippedChildEnv(),
      });
    } catch (err) {
      settle({
        ok: false,
        stdout: "",
        stderr: "",
        reason: (err as Error).message,
        attempts: 1,
      });
      return;
    }

    // Chunks instead of string += to avoid O(n²) concat on large
    // outputs and to keep accumulation O(1) per data event.
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let stdoutBytes = 0;
    let lineBuf = "";
    let timedOut = false;
    let stdoutOverflowed = false;

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (!stdoutOverflowed) {
        stdoutChunks.push(chunk);
        stdoutBytes += Buffer.byteLength(chunk, "utf8");
        if (stdoutBytes > MAX_MRA_STDOUT_BYTES) {
          stdoutOverflowed = true;
          try {
            child.kill("SIGTERM");
          } catch {
            /* already gone */
          }
        }
      }
      // Progress streaming continues regardless: by the time we set
      // the flag we already kicked SIGTERM, but the child may still
      // emit a few more lines before it actually dies. Surface those
      // to the caller — only the accumulator is capped.
      lineBuf += chunk;
      let idx: number;
      while ((idx = lineBuf.indexOf("\n")) >= 0) {
        const raw = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (line.length === 0) continue;
        try {
          opts.onProgress?.(line);
        } catch {
          /* sink failures must not tear down stdout reading */
        }
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (err) => {
      settle({
        ok: false,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        reason: err.message,
        attempts: 1,
      });
    });

    child.on("close", (code, signal) => {
      const stdout = stdoutChunks.join("");
      const stderr = stderrChunks.join("");
      const ok = !timedOut && !stdoutOverflowed && code === 0;
      if (ok) {
        settle({ ok: true, stdout, stderr, attempts: 1 });
        return;
      }
      let reason: string;
      if (stdoutOverflowed) {
        reason = `mra ask stdout exceeded ${MAX_MRA_STDOUT_BYTES} bytes`;
      } else if (timedOut) {
        reason = `mra ask timed out after ${timeoutMs}ms`;
      } else {
        const lastStderrLine = stderr.trim().split("\n").pop();
        reason = `mra ask exited with code=${code ?? "null"}${
          signal ? ` signal=${signal}` : ""
        }${stderr.trim() ? `: ${lastStderrLine}` : ""}`;
      }
      settle({ ok: false, stdout, stderr, reason, attempts: 1 });
    });
  });
}

// ---------------------------------------------------------------------------
// mra review — write-protected, secrets-stripped subprocess
// ---------------------------------------------------------------------------

/**
 * Shared spawn/line-buffer/timeout loop used by both `runMraAskOnce`
 * and `spawnMraCommand`. Takes explicit `argv` + `env` so the caller
 * can customise both without duplicating the machinery.
 *
 * Behaviour is identical to `runMraAskOnce` (chunks, overflow guard,
 * SIGTERM on timeout, settle-once). On success, `parseResult` is called
 * on the accumulated stdout and merged into the returned value.
 */
function spawnMraCommand(
  binary: string,
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  onProgress: ((line: string) => void) | undefined,
  /** When aborted (gateway shutdown / drain), SIGTERM the child and settle. */
  signal?: AbortSignal,
): Promise<{ ok: boolean; stdout: string; stderr: string; reason?: string }> {
  return new Promise((resolve) => {
    let timeoutHandle: NodeJS.Timeout | undefined;
    let settled = false;
    let onAbort: (() => void) | undefined;
    const settle = (r: {
      ok: boolean;
      stdout: string;
      stderr: string;
      reason?: string;
    }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, argv, { cwd, stdio: ["ignore", "pipe", "pipe"], env });
    } catch (err) {
      settle({ ok: false, stdout: "", stderr: "", reason: (err as Error).message });
      return;
    }

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let stdoutBytes = 0;
    let lineBuf = "";
    let timedOut = false;
    let aborted = false;
    let stdoutOverflowed = false;

    // A: on gateway shutdown, kill the in-flight review child so it can't run
    // on as an orphan (wasting compute, possibly posting after the claim is
    // released). The close handler reports an "aborted" reason.
    onAbort = () => {
      aborted = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (!stdoutOverflowed) {
        stdoutChunks.push(chunk);
        stdoutBytes += Buffer.byteLength(chunk, "utf8");
        if (stdoutBytes > MAX_MRA_STDOUT_BYTES) {
          stdoutOverflowed = true;
          try {
            child.kill("SIGTERM");
          } catch {
            /* already gone */
          }
        }
      }
      lineBuf += chunk;
      let idx: number;
      while ((idx = lineBuf.indexOf("\n")) >= 0) {
        const raw = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (line.length === 0) continue;
        try {
          onProgress?.(line);
        } catch {
          /* sink failures must not tear down stdout reading */
        }
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (err) => {
      settle({
        ok: false,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        reason: err.message,
      });
    });

    child.on("close", (code, signal) => {
      const stdout = stdoutChunks.join("");
      const stderr = stderrChunks.join("");
      const ok = !timedOut && !stdoutOverflowed && !aborted && code === 0;
      if (ok) {
        settle({ ok: true, stdout, stderr });
        return;
      }
      let reason: string;
      if (aborted) {
        reason = "aborted (gateway shutdown)";
      } else if (stdoutOverflowed) {
        reason = `mra stdout exceeded ${MAX_MRA_STDOUT_BYTES} bytes`;
      } else if (timedOut) {
        reason = `mra timed out after ${timeoutMs}ms`;
      } else {
        const lastStderrLine = stderr.trim().split("\n").pop();
        reason = `mra exited with code=${code ?? "null"}${
          signal ? ` signal=${signal}` : ""
        }${stderr.trim() ? `: ${lastStderrLine}` : ""}`;
      }
      settle({ ok: false, stdout, stderr, reason });
    });
  });
}

/**
 * Run `mra review <project> --pr <pr>` as a write-protected subprocess.
 * Secrets are stripped from the child env (see {@link REVIEW_SECRET_ENV_DENYLIST}).
 * No retry here; the coordinator owns retry policy.
 * Default timeout is 600s (reviews are substantially slower than asks).
 */
export async function runMraReview(
  args: {
    workspace: string;
    project: string;
    pr: number;
    strategy: ReviewStrategy;
    cwd: string;
    timeoutMs?: number;
    /** Abort to SIGTERM the review child (gateway shutdown / drain). */
    signal?: AbortSignal;
    providerMode?: ReviewProviderMode;
    expectedHeadSha?: string;
    baseRef?: string;
    baseSha?: string;
    prContext?: { title?: string; body?: string; updatedAt?: string; discussion?: readonly PrDiscussionItem[] };
  },
  opts: { onProgress?: (line: string) => void } = {},
): Promise<MraReviewResult> {
  const binary = findMraBinary();
  if (!binary) {
    return { ok: false, stdout: "", stderr: "", reason: "`mra` binary not found on PATH" };
  }
  const protocol = args.providerMode === "codex" || args.providerMode === undefined
    ? mraIntegrationCapabilities(binary)
    : undefined;
  if (protocol) {
    const checkout = path.join(args.workspace, args.project);
    const expectedHead = args.expectedHeadSha ?? "";
    if (!/^[0-9a-f]{40}$/i.test(expectedHead)) {
      return { ok: false, stdout: "", stderr: "", reason: "protocol review requires expectedHeadSha" };
    }
    let baseSha = args.baseSha ?? "";
    if (!/^[0-9a-f]{40}$/i.test(baseSha)) {
      const baseRef = args.baseRef ?? "main";
      for (const candidate of [baseRef, `origin/${baseRef}`]) {
        try {
          baseSha = execFileSync("git", ["-C", checkout, "merge-base", expectedHead, candidate], {
            encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
          }).trim();
          if (/^[0-9a-f]{40}$/i.test(baseSha)) break;
        } catch { /* try remote-tracking ref */ }
      }
      if (!/^[0-9a-f]{40}$/i.test(baseSha))
        return { ok: false, stdout: "", stderr: "", reason: "cannot resolve protocol review base SHA" };
    }
    const runDir = mkdtempSync(path.join(os.tmpdir(), "pmk-mra-review-"));
    const requestPath = path.join(runDir, "request.json");
    const resultPath = path.join(runDir, "result.json");
    const eventsPath = path.join(runDir, "events.jsonl");
    const requestId = randomUUID();
    const requestJson = JSON.stringify({
      schema: "io.mra.integration.review-request/v1",
      protocolVersion: "1.0",
      requestId,
      subject: { checkout, project: args.project, pullRequest: args.pr, baseSha, headSha: expectedHead },
      review: { provider: args.providerMode ?? "codex", strategy: "standard" },
      context: { pr: args.prContext ?? {} },
    });
    const requestSha256 = createHash("sha256").update(requestJson).digest("hex");
    writeFileSync(requestPath, requestJson, { mode: 0o600 });
    const env = strippedChildEnv();
    const timeoutMs = args.timeoutMs ?? 1_200_000;
    try {
      const raw = await spawnMraCommand(binary, ["integration", "review", "--request", requestPath, "--result", resultPath, "--events", eventsPath], args.cwd, env, timeoutMs, opts.onProgress, args.signal);
      if (!existsSync(resultPath)) return { ...raw, ok: false, reason: raw.reason ?? "mra protocol result artifact missing" };
      const artifact = JSON.parse(readFileSync(resultPath, "utf8")) as {
        schema?: string; protocolVersion?: string; requestId?: string; requestSha256?: string; artifactSha256?: string;
        subject?: { headSha?: string; baseSha?: string }; producer?: { product?: string };
        context?: { mode?: string; nativeRepositoryInstructions?: boolean };
        providers?: Array<{ provider?: string; status?: string }>;
        analysis?: { status?: string; verdict?: string };
        findings?: unknown[]; blockerLedger?: unknown[]; errors?: unknown[];
      };
      const { artifactSha256, ...unsignedArtifact } = artifact;
      const computedArtifactSha256 = createHash("sha256").update(JSON.stringify(unsignedArtifact)).digest("hex");
      const findings = artifact.findings ?? [];
      const findingIsValid = (f: unknown): f is { path: string; line: number; body: string; severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" } => {
        if (!f || typeof f !== "object") return false;
        const v = f as Record<string, unknown>;
        return typeof v.path === "string" && v.path.length > 0 && Number.isInteger(v.line) &&
          typeof v.body === "string" && v.body.length > 0 && ["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(String(v.severity));
      };
      const validFindings = Array.isArray(findings) && findings.every(findingIsValid);
      const derivedBlockers = validFindings ? findings.filter((f) => f.severity === "CRITICAL" || f.severity === "HIGH") : [];
      const ledgerMatches = Array.isArray(artifact.blockerLedger) && JSON.stringify(artifact.blockerLedger) === JSON.stringify(derivedBlockers);
      const verdictMatches = artifact.analysis?.status === "complete" &&
        ((artifact.analysis.verdict === "pass" && derivedBlockers.length === 0) ||
         (artifact.analysis.verdict === "block" && derivedBlockers.length > 0));
      const valid = artifact.schema === "io.mra.integration.review-result/v1" && artifact.protocolVersion === "1.0" &&
        artifact.requestId === requestId && artifact.subject?.headSha === expectedHead && artifact.subject?.baseSha === baseSha &&
        artifact.requestSha256 === requestSha256 && artifactSha256 === computedArtifactSha256 &&
        artifact.producer?.product === "multi-repo-agent" && artifact.context?.mode === "sanitized-untrusted" &&
        artifact.context.nativeRepositoryInstructions === false && artifact.providers?.length === 1 &&
        artifact.providers[0]?.provider === "codex" && artifact.providers[0]?.status === "complete" &&
        Array.isArray(artifact.errors) && artifact.errors.length === 0 && validFindings && ledgerMatches && verdictMatches;
      if (!valid) return { ...raw, ok: false, reason: "invalid or mismatched mra protocol artifact" };
      const blockers = derivedBlockers;
      const complete = artifact.analysis?.status === "complete";
      const status = artifact.analysis?.verdict === "pass" ? "COMMENT"
        : artifact.analysis?.verdict === "block" ? "CHANGES_REQUESTED" : "COMMENT";
      return {
        ...raw,
        ok: raw.ok && complete,
        status,
        commentCount: findings.length,
        blockerCount: blockers.length,
        incomplete: !complete,
        protocolVersion: "1.0",
        artifactSha256: artifact.artifactSha256,
        analyzedHeadSha: expectedHead,
        summary: typeof (artifact as { summary?: unknown }).summary === "string" ? (artifact as { summary: string }).summary : undefined,
        findings: findings.map((f) => ({ path: f.path, line: f.line, body: f.body, severity: f.severity })),
        reason: raw.ok && complete ? undefined : raw.reason ?? "mra protocol analysis incomplete",
      };
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  }
  if (args.providerMode && !mraSupportsReviewProvider(binary)) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      reason: "installed `mra` does not support `review --provider`; upgrade multi-repo-agent before using PMK review provider selection",
    };
  }
  // 20 min: the debate pipeline runs sequential multi-agent stages (round 1 →
  // mailbox voting → synthesis); on a large PR (many files / >5 findings) that
  // legitimately exceeds 10 min even with a PKB, so 600s timed out mid-pipeline.
  const timeoutMs = args.timeoutMs ?? 1_200_000;
  const argv = buildReviewArgv(args.project, args.pr, args.strategy, args.providerMode);
  const env = reviewEnv(args.strategy, {
    providerMode: args.providerMode,
    expectedHeadSha: args.expectedHeadSha,
  });

  const raw = await spawnMraCommand(binary, argv, args.cwd, env, timeoutMs, opts.onProgress, args.signal);
  const parsed: Partial<ReturnType<typeof parseReviewStdout>> = raw.ok ? parseReviewStdout(raw.stdout) : {};
  // Legacy MRA is review-only. Human stdout can describe a posted comment but
  // never establishes approval eligibility.
  const incomplete = parsed.incomplete === true || !parsed.status;
  return { ...raw, ...parsed, ok: raw.ok && !incomplete, incomplete, blockerCount: undefined, protocolVersion: undefined,
    reason: raw.ok && incomplete ? "legacy mra did not emit a complete structured verdict" : raw.reason };
}

/**
 * Run `mra analyze <project>` to (re)build the project's PKB on the MAIN clone,
 * just-in-time before a review. Without a PKB the review agents grep the whole
 * codebase and hit --max-turns (→ REVIEW_INCOMPLETE); a PKB makes them finish.
 * PKB generation is multi-agent and slow, so the timeout is generous. `cwd` must
 * be the mra workspace (the project resolves under it; also pinned via
 * MRA_WORKSPACE). Secrets are stripped like the review path — claude authenticates
 * via its own session, not ANTHROPIC_API_KEY in this env.
 */
export async function runMraAnalyze(
  args: { project: string; cwd: string; timeoutMs?: number; signal?: AbortSignal },
  opts: { onProgress?: (line: string) => void } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string; reason?: string }> {
  const binary = findMraBinary();
  if (!binary) {
    return { ok: false, stdout: "", stderr: "", reason: "`mra` binary not found on PATH" };
  }
  const timeoutMs = args.timeoutMs ?? 900_000; // 15 min — PKB gen runs many agents
  const env = strippedChildEnv();
  env.MRA_WORKSPACE = args.cwd;
  return spawnMraCommand(
    binary,
    ["analyze", args.project],
    args.cwd,
    env,
    timeoutMs,
    opts.onProgress,
    args.signal,
  );
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

/**
 * Map a GitHub `owner/repo` slug to the mra project NAME whose local clone's
 * origin points at it. Enumerates `.collab/repos.json` (all non-archived repos,
 * not just PKB-having ones). Used by the review flow to turn a PR link into the
 * `<project>` arg for `mra review`. Case-insensitive; `.git` stripped.
 */
export function resolveProjectByRemote(
  workspace: string,
  ownerRepo: string,
): string | undefined {
  const want = normalizeSlug(ownerRepo);
  // 1. Preferred: repos.json-registered (non-archived) repos — the mra-managed
  //    manifest. Fast path that respects the operator's curated set.
  const fromManifest = matchManifestRepo(workspace, want);
  if (fromManifest) return fromManifest;
  // 2. Fallback: any git repo physically present under the workspace whose
  //    origin matches. A cloned-but-UNREGISTERED repo (not in repos.json) can
  //    still be reviewed — `mra review` only needs the dir to exist; dep-graph
  //    context just degrades. Without this, a valid clone missing from the
  //    manifest is wrongly reported as "not in workspace" (live-found 2026-06-23).
  return matchWorkspaceDir(workspace, want);
}

function matchManifestRepo(workspace: string, want: string): string | undefined {
  const reposJson = path.join(workspace, ".collab", "repos.json");
  if (!existsSync(reposJson)) return undefined;
  let manifest: ReposJson;
  try {
    manifest = JSON.parse(readFileSync(reposJson, "utf8")) as ReposJson;
  } catch {
    return undefined;
  }
  for (const r of manifest.repos ?? []) {
    if (r.archived) continue;
    if (originSlugOf(path.join(workspace, r.name)) === want) return r.name;
  }
  return undefined;
}

function matchWorkspaceDir(workspace: string, want: string): string | undefined {
  let entries: Dirent[];
  try {
    entries = readdirSync(workspace, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    if (originSlugOf(path.join(workspace, e.name)) === want) return e.name;
  }
  return undefined;
}

/** `owner/repo` slug of a repo's `origin` remote, or undefined (not a git repo / no origin). */
function originSlugOf(repoPath: string): string | undefined {
  if (!existsSync(path.join(repoPath, ".git"))) return undefined;
  let remote = "";
  try {
    remote = execFileSync("git", ["-C", repoPath, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
  return remote ? normalizeSlug(remote) : undefined;
}

/** Reduce a remote URL or `owner/repo` to a lowercase `owner/repo` (no `.git`). */
function normalizeSlug(s: string): string {
  const noGit = s.replace(/\.git$/, "");
  const m = /[:/]([^/:]+\/[^/]+)$/.exec(noGit) ?? /^([^/]+\/[^/]+)$/.exec(noGit);
  return (m ? m[1] : noGit).toLowerCase();
}
