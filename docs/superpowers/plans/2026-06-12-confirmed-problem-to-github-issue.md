# Confirmed Problem → GitHub Issue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tech, after the bot escalates a diagnosed problem, open a structured GitHub issue in the problem's repo with a single 🎫 reaction — using a work GitHub token, never the host's personal `gh` login.

**Architecture:** A new `gh`-CLI adapter (`adapters/github.ts`) wraps issue creation behind an injectable exec seam (mirrors `adapters/mra.ts`). At escalate() time the coordinator writes a durable, snapshot `issue-candidate` record (independent of the consumable escalation marker). A widened `reaction_added` handler claims that record atomically (lock-then-finalize), resolves repo/token/visibility, and opens the issue from the snapshot — no Slack history reads.

**Tech Stack:** TypeScript (CommonJS), `node:test` + `node:assert/strict` via `tsx`, `gh` CLI via `execFile`, Slack `@slack/web-api`, the existing secret-reference system (`{cmd}`/`{env}`).

**Spec:** `docs/superpowers/specs/2026-06-12-confirmed-problem-to-github-issue-design.md` (Draft v6.1).

---

## File Structure

**New files:**
- `packages/cli/src/adapters/github.ts` — gh-CLI wrapper: `findGhBinary`, `isSafeRepoPath`, `resolveRepoSlug`, `repoVisibility`, `createIssue`, `githubDoctor`. Injectable `GithubExec` seam.
- `packages/cli/src/gateway/issue-candidate.ts` — durable snapshot record + lock-then-finalize store (`save`/`load`/`claim`/`release`/`finalize`/`recoverIssueClaims`).
- `packages/cli/src/gateway/slack/issue.ts` — `IssueCoordinator.fromCandidate()`: load → authorize → claim → resolve → build → createIssue → finalize → audit → reply.
- `packages/cli/test/github.test.ts`, `packages/cli/test/issue-candidate.test.ts` — unit tests.

**Modified files:**
- `packages/cli/src/gateway/config.ts` — add `github?: { token: SecretSource; allowPublicRepos?: boolean }` to `GatewayConfig`; `resolveGithubToken`; normalise.
- `packages/cli/src/gateway/events.ts` — add `github.issue.created` / `github.issue.failed`.
- `packages/cli/src/gateway/escalate.ts` — `safeRepoHint` preserves nested `erp/order`.
- `packages/cli/src/gateway/slack/escalation.ts` — `escalate()` takes `diagnosis`, captures anchorTs, permalink, writes candidate (gated on repo), appends 🎫 via `chat.update`.
- `packages/cli/src/gateway/slack/free-chat-turn.ts` — hoist `visible`, pass as `diagnosis`.
- `packages/cli/src/gateway/slack/index.ts` — widen reaction gate for `ticket`; construct + dispatch `IssueCoordinator`.
- `packages/cli/src/gateway/doctor.ts` — `github-token` check + stale-claim + public-repo warnings.
- `packages/cli/test/harness/slack-fakes.ts` — add `chat.getPermalink` to `FakeWebClient`; allow injecting fake github deps.

**Conventions (apply everywhere):** import from src with NO `.js` extension; tests use `import { describe, it, beforeEach, afterEach } from "node:test"` + `import * as assert from "node:assert/strict"`; redirect `~/.pmk` by setting `process.env.HOME` to a `fs.mkdtempSync` dir; run a single test file with `node --import tsx --test test/<name>.test.ts`.

---

## Task 1: `github.ts` — gh-CLI adapter (path validation, slug, visibility, createIssue, doctor)

**Files:**
- Create: `packages/cli/src/adapters/github.ts`
- Test: `packages/cli/test/github.test.ts`

This is the leaf module — no gateway deps. Every shell-out goes through an injectable `GithubExec` so tests never spawn a real process. No-leak: error messages carry only an exit code, never the token/stdout/stderr.

- [ ] **Step 1: Write failing tests for path validation + slug parsing**

Create `packages/cli/test/github.test.ts`:

```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  isSafeRepoPath,
  resolveRepoSlug,
  repoVisibility,
  createIssue,
  type GithubExec,
} from "../src/adapters/github";

describe("isSafeRepoPath", () => {
  it("accepts a bare name and a nested id", () => {
    assert.equal(isSafeRepoPath("erp"), true);
    assert.equal(isSafeRepoPath("erp/order"), true);
    assert.equal(isSafeRepoPath("a.b_c-d/e"), true);
  });
  it("rejects traversal, absolute, separators, empty segments", () => {
    assert.equal(isSafeRepoPath("../etc"), false);
    assert.equal(isSafeRepoPath("/abs"), false);
    assert.equal(isSafeRepoPath("a//b"), false);
    assert.equal(isSafeRepoPath("a\\b"), false);
    assert.equal(isSafeRepoPath("a\0b"), false);
    assert.equal(isSafeRepoPath(""), false);
    assert.equal(isSafeRepoPath(".."), false);
  });
});

describe("resolveRepoSlug", () => {
  const exec = (stdout: string): GithubExec => async () => ({ stdout });
  it("parses ssh origin", async () => {
    const slug = await resolveRepoSlug("/ws", "erp", {
      exec: exec("git@github.com:onead/erp.git\n"),
    });
    assert.equal(slug, "onead/erp");
  });
  it("parses https origin (with and without .git)", async () => {
    assert.equal(
      await resolveRepoSlug("/ws", "erp", { exec: exec("https://github.com/onead/erp.git\n") }),
      "onead/erp",
    );
    assert.equal(
      await resolveRepoSlug("/ws", "erp", { exec: exec("https://github.com/onead/erp\n") }),
      "onead/erp",
    );
  });
  it("returns undefined for non-github / no origin", async () => {
    assert.equal(
      await resolveRepoSlug("/ws", "erp", { exec: exec("git@gitlab.com:x/y.git\n") }),
      undefined,
    );
    const throwing: GithubExec = async () => {
      throw new Error("fatal: no such remote");
    };
    assert.equal(await resolveRepoSlug("/ws", "erp", { exec: throwing }), undefined);
  });
  it("rejects an unsafe repo BEFORE exec (never calls exec)", async () => {
    let called = false;
    const spy: GithubExec = async () => {
      called = true;
      return { stdout: "" };
    };
    assert.equal(await resolveRepoSlug("/ws", "../etc", { exec: spy }), undefined);
    assert.equal(called, false);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd packages/cli && node --import tsx --test test/github.test.ts`
Expected: FAIL — `Cannot find module '../src/adapters/github'`.

- [ ] **Step 3: Implement `github.ts` (validation + slug + exec seam)**

Create `packages/cli/src/adapters/github.ts`:

```ts
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
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd packages/cli && node --import tsx --test test/github.test.ts`
Expected: PASS (path validation + slug parsing suites green).

- [ ] **Step 5: Write failing tests for `repoVisibility` + `createIssue` (no-leak)**

Append to `packages/cli/test/github.test.ts`:

```ts
describe("repoVisibility", () => {
  it("maps gh output to public/private, errors to unknown", async () => {
    const ok = (v: string): GithubExec => async () => ({ stdout: v + "\n" });
    assert.equal(await repoVisibility({ slug: "o/r", token: "T" }, { exec: ok("PUBLIC") }), "public");
    assert.equal(await repoVisibility({ slug: "o/r", token: "T" }, { exec: ok("PRIVATE") }), "private");
    const boom: GithubExec = async () => {
      throw new Error("gh: not found");
    };
    assert.equal(await repoVisibility({ slug: "o/r", token: "T" }, { exec: boom }), "unknown");
  });
});

describe("createIssue", () => {
  it("builds the right argv, passes GH_TOKEN in env, returns the URL", async () => {
    let seenFile = "";
    let seenArgs: string[] = [];
    let seenEnv: NodeJS.ProcessEnv = {};
    const exec: GithubExec = async (file, args, opts) => {
      seenFile = file;
      seenArgs = args;
      seenEnv = opts.env ?? {};
      return { stdout: "https://github.com/o/r/issues/7\n" };
    };
    const url = await createIssue(
      { slug: "o/r", title: "[pmk] x", body: "B", token: "SECRET-TOKEN" },
      { exec },
    );
    assert.equal(url, "https://github.com/o/r/issues/7");
    assert.deepEqual(seenArgs, ["issue", "create", "-R", "o/r", "--title", "[pmk] x", "--body", "B"]);
    assert.equal(seenEnv.GH_TOKEN, "SECRET-TOKEN");
    assert.match(seenFile, /gh$|gh$/);
  });
  it("on failure throws WITHOUT leaking the token or stderr", async () => {
    const exec: GithubExec = async () => {
      const e = new Error("gh failed: token=SECRET-TOKEN bad auth") as Error & { code?: number };
      e.code = 1;
      throw e;
    };
    await assert.rejects(
      () => createIssue({ slug: "o/r", title: "t", body: "b", token: "SECRET-TOKEN" }, { exec }),
      (err: Error) => {
        assert.doesNotMatch(err.message, /SECRET-TOKEN/);
        assert.doesNotMatch(err.message, /bad auth/);
        assert.match(err.message, /gh issue create failed/);
        return true;
      },
    );
  });
});
```

- [ ] **Step 6: Run tests, verify they fail**

Run: `cd packages/cli && node --import tsx --test test/github.test.ts`
Expected: FAIL — `repoVisibility`/`createIssue` are not exported yet.

- [ ] **Step 7: Implement `repoVisibility`, `createIssue`, `githubDoctor`**

Append to `packages/cli/src/adapters/github.ts`:

```ts
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
```

- [ ] **Step 8: Run tests, verify they pass**

Run: `cd packages/cli && node --import tsx --test test/github.test.ts`
Expected: PASS (all github suites). Then `npm run typecheck:test` from `packages/cli` — expect no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/adapters/github.ts packages/cli/test/github.test.ts
git commit -m "feat(gateway): github.ts gh-CLI adapter — slug/visibility/createIssue with injectable exec + no-leak"
```

## Task 2: `config.ts` — `github` config + `resolveGithubToken`

**Files:**
- Modify: `packages/cli/src/gateway/config.ts` (interface ~118; `normaliseRawConfig` return ~258-268; add `resolveGithubToken` near `resolveGatewayApiKey` ~335)
- Test: `packages/cli/test/config.test.ts` (or append to the existing config test file if present; otherwise create)

The token stays a `SecretSource` in `GatewayConfig` (resolved lazily, exactly like `apiKey`). `allowPublicRepos` defaults to false.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/github-config.test.ts`:

```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { normaliseRawConfigForTest, resolveGithubToken } from "../src/gateway/config";

describe("github config", () => {
  it("normalises a literal token + allowPublicRepos", () => {
    const c = normaliseRawConfigForTest({
      version: 1,
      github: { token: "ghp_literal", allowPublicRepos: true },
    });
    assert.deepEqual(c.github, { token: "ghp_literal", allowPublicRepos: true });
  });
  it("normalises a {cmd} reference and defaults allowPublicRepos to undefined", () => {
    const c = normaliseRawConfigForTest({
      version: 1,
      github: { token: { cmd: "op read op://v/gh" } },
    });
    assert.deepEqual(c.github?.token, { cmd: "op read op://v/gh" });
    assert.equal(c.github?.allowPublicRepos, undefined);
  });
  it("resolveGithubToken returns a literal, undefined when unset", () => {
    assert.equal(resolveGithubToken({ token: "ghp_x" }), "ghp_x");
    assert.equal(resolveGithubToken(undefined), undefined);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd packages/cli && node --import tsx --test test/github-config.test.ts`
Expected: FAIL — `resolveGithubToken` is not exported / `c.github` undefined.

- [ ] **Step 3: Add the `github` field to `GatewayConfig`**

In `packages/cli/src/gateway/config.ts`, inside `interface GatewayConfig` (right after the `apiKey?: SecretSource;` field, ~line 118):

```ts
  /**
   * Work GitHub credentials for the confirmed-problem → issue flow.
   * `token` is a literal or {env}/{cmd} reference, resolved lazily at
   * 🎫 time (see resolveGithubToken) so a {cmd} never runs at load.
   * `allowPublicRepos` (default false) blocks opening issues on a PUBLIC
   * repo — internal diagnosis content must not leak to a public repo.
   */
  github?: { token: SecretSource; allowPublicRepos?: boolean };
```

- [ ] **Step 4: Normalise `github` in `normaliseRawConfig`**

In `normaliseRawConfig`, add a local helper above the `return {` (~line 258) and a field in the returned object. Add the helper:

```ts
  const rawGithub = (r as { github?: unknown }).github;
  const github =
    rawGithub && typeof rawGithub === "object"
      ? {
          token: validateSecretSource(
            (rawGithub as { token?: unknown }).token as never,
            "github.token",
          )!,
          allowPublicRepos:
            (rawGithub as { allowPublicRepos?: unknown }).allowPublicRepos === true
              ? true
              : undefined,
        }
      : undefined;
```

Then add to the returned object (after `apiKey: ...,`):

```ts
    github,
```

Note: `validateSecretSource` already throws on a malformed reference (mirrors `apiKey`). A `github` object with no `token` yields `validateSecretSource(undefined, ...)` → undefined; if that is unacceptable, the `!` keeps the field type `SecretSource` — guard by only constructing `github` when a token is present (the `rawGithub && typeof === object` check plus relying on validateSecretSource throwing for malformed). For an empty `{}` github, drop it: change the condition to `rawGithub && typeof rawGithub === "object" && "token" in rawGithub`.

- [ ] **Step 5: Add `resolveGithubToken`**

After `resolveGatewayApiKey` (~line 343) in `config.ts`:

```ts
/**
 * Resolve the work GitHub token from the gateway config (literal or
 * {env}/{cmd}). Mirrors resolveGatewayApiKey; returns undefined if unset.
 * Resolved lazily at 🎫 time, never at load.
 */
export function resolveGithubToken(
  github: GatewayConfig["github"],
): string | undefined {
  return resolveSecret(github?.token, "github.token");
}
```

Also update `RawGatewayConfig` if needed — since `RawGatewayConfig extends Omit<GatewayConfig, "slack">`, the `github` field is inherited automatically with the raw `SecretSource` token shape. No separate edit needed.

- [ ] **Step 6: Run test, verify it passes**

Run: `cd packages/cli && node --import tsx --test test/github-config.test.ts`
Expected: PASS. Then `npm run typecheck:test` — no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/gateway/config.ts packages/cli/test/github-config.test.ts
git commit -m "feat(gateway): github config (token SecretSource + allowPublicRepos) + resolveGithubToken"
```

---

## Task 3: `events.ts` — `github.issue.created` / `github.issue.failed`

**Files:**
- Modify: `packages/cli/src/gateway/events.ts` (union ~185-194; `VALID_TYPES` ~199-210; add two interfaces)
- Test: `packages/cli/test/events.test.ts` (append, or create `github-events.test.ts`)

Two distinct, token-free payloads. `failed.repo` is optional (it may fail before the slug resolves); `failed` has NO url.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/github-events.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendGatewayEvent, readGatewayEvents } from "../src/gateway/events";

describe("github issue events", () => {
  let home: string;
  const orig = process.env.HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-ghev-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    if (orig !== undefined) process.env.HOME = orig;
  });

  it("round-trips created + failed through the reader", () => {
    appendGatewayEvent({
      type: "github.issue.created",
      actor: "U-IT",
      repo: "o/r",
      url: "https://github.com/o/r/issues/7",
    });
    appendGatewayEvent({
      type: "github.issue.failed",
      actor: "U-IT",
      reason: "no-gh",
    });
    const evs = readGatewayEvents();
    const types = evs.map((e) => e.type);
    assert.ok(types.includes("github.issue.created"));
    assert.ok(types.includes("github.issue.failed"));
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd packages/cli && node --import tsx --test test/github-events.test.ts`
Expected: FAIL — TS error: `"github.issue.created"` not assignable to a `GatewayEvent` type (or reader drops them because not in `VALID_TYPES`).

- [ ] **Step 3: Add the two event interfaces**

In `packages/cli/src/gateway/events.ts`, near the other event interfaces (above the `GatewayEvent` union ~line 185):

```ts
export interface GithubIssueCreatedEvent {
  type: "github.issue.created";
  /** Slack user id of the 🎫 reactor. */
  actor: string;
  /** owner/repo slug. */
  repo: string;
  /** Created issue URL. */
  url: string;
}

export interface GithubIssueFailedEvent {
  type: "github.issue.failed";
  actor: string;
  /** Optional — may fail before the slug resolves. */
  repo?: string;
  /** no-gh | token | slug | public-repo | gh-create-failed */
  reason: string;
}
```

(Neither payload carries the token — by construction.)

- [ ] **Step 4: Add both to the union and `VALID_TYPES`**

In the `GatewayEvent` union (~line 185), add:

```ts
  | GithubIssueCreatedEvent
  | GithubIssueFailedEvent
```

In the `VALID_TYPES` set (~line 199), add:

```ts
  "github.issue.created",
  "github.issue.failed",
```

- [ ] **Step 5: Run test, verify it passes**

Run: `cd packages/cli && node --import tsx --test test/github-events.test.ts`
Expected: PASS. Then `npm run typecheck:test` — no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/gateway/events.ts packages/cli/test/github-events.test.ts
git commit -m "feat(gateway): add github.issue.created/failed events (token-free payloads)"
```

---

## Task 4: `escalate.ts` — `safeRepoHint` preserves nested repos

**Files:**
- Modify: `packages/cli/src/gateway/escalate.ts:32-35` (`safeRepoHint`)
- Test: `packages/cli/test/escalate.test.ts` (append, or create `escalate-parser.test.ts`)

`safeRepoHint` currently strips `/` (`erp/order` → `erporder`), defeating nested-repo support at the parser boundary. Relax to the same safe-relative-path rule, still ≤64 chars.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/escalate-parser.test.ts`:

```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { parseEscalate } from "../src/gateway/escalate";

const fence = (body: string) => "```escalate\n" + body + "\n```";

describe("parseEscalate repo hint", () => {
  it("preserves a nested repo id", () => {
    const r = parseEscalate(fence("repo: erp/order\nquestion: why broken"));
    assert.equal(r?.repo, "erp/order");
  });
  it("keeps a bare repo id", () => {
    const r = parseEscalate(fence("repo: erp\nquestion: q"));
    assert.equal(r?.repo, "erp");
  });
  it("strips traversal to a safe form (no .. survives)", () => {
    const r = parseEscalate(fence("repo: ../../etc\nquestion: q"));
    assert.ok(!r?.repo || !r.repo.includes(".."));
  });
  it("undefined repo when absent", () => {
    const r = parseEscalate(fence("question: q"));
    assert.equal(r?.repo, undefined);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd packages/cli && node --import tsx --test test/escalate-parser.test.ts`
Expected: FAIL — nested test gets `"erporder"`, not `"erp/order"`.

- [ ] **Step 3: Update `safeRepoHint`**

Replace `safeRepoHint` (escalate.ts:32-35) with:

```ts
/**
 * Restrict the LLM-supplied repo hint to a safe relative path. mra repo
 * ids are legitimately nested (e.g. `erp/order`), so we allow `/`-joined
 * segments of [A-Za-z0-9._-] — but reject traversal, empty segments, and
 * a leading `/`, and drop any other character. Capped at 64 chars.
 */
function safeRepoHint(s: string): string | undefined {
  const cleaned = s
    .replace(/[^a-zA-Z0-9._/-]/g, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .slice(0, 64);
  const segs = cleaned.split("/").filter((seg) => seg.length > 0 && seg !== "..");
  const safe = segs.join("/");
  return safe || undefined;
}
```

This drops disallowed chars, collapses `//`, removes a leading `/`, then filters out empty / `..` segments and re-joins. `../../etc` → `etc`; `erp/order` → `erp/order`.

- [ ] **Step 4: Run test, verify it passes**

Run: `cd packages/cli && node --import tsx --test test/escalate-parser.test.ts`
Expected: PASS. Run the existing escalate test too: `node --import tsx --test test/escalate.test.ts` (if present) — expect still green.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/escalate.ts packages/cli/test/escalate-parser.test.ts
git commit -m "fix(gateway): safeRepoHint preserves nested repo ids (erp/order) while rejecting traversal"
```

---

## Task 5: `issue-candidate.ts` — durable snapshot + lock-then-finalize store

**Files:**
- Create: `packages/cli/src/gateway/issue-candidate.ts`
- Test: `packages/cli/test/issue-candidate.test.ts`

Records live at `<gatewayDir>/issue-candidates/<channelId>__<anchorTs>.json` (mode 0600). Reuse `gatewayDir` + `assertSafeSegment` from existing modules. Lifecycle: `claim` renames `.json → .claiming` (atomic); `finalize` writes the url into `.claiming` then renames `.claiming → .json`; `release` renames `.claiming → .json`. `claim` does NOT delete (unlike `claimThreadEscalation`).

- [ ] **Step 1: Write failing tests (save/load 0600, claim atomicity, finalize, release, recover)**

Create `packages/cli/test/issue-candidate.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  saveIssueCandidate,
  loadIssueCandidate,
  claimIssueCandidate,
  releaseIssueCandidate,
  finalizeIssueCandidate,
  recoverIssueClaims,
  issueCandidatePath,
  type IssueCandidate,
} from "../src/gateway/issue-candidate";

const sample = (over: Partial<IssueCandidate> = {}): IssueCandidate => ({
  channelId: "C1",
  threadTs: "100.1",
  anchorTs: "100.2",
  scope: "erp",
  askerUserId: "U-ASK",
  mentionedUserIds: ["U-IT"],
  question: "why broken",
  diagnosis: "root cause at a.rb:10",
  ...over,
});

describe("issue-candidate store", () => {
  let home: string;
  const orig = process.env.HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-issue-cand-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    if (orig !== undefined) process.env.HOME = orig;
  });

  it("save round-trips and writes mode 0600", () => {
    const c = sample();
    saveIssueCandidate(c);
    assert.deepEqual(loadIssueCandidate("C1", "100.2"), c);
    const mode = fs.statSync(issueCandidatePath("C1", "100.2")).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it("load distinguishes corrupt (logs) from missing (silent)", () => {
    assert.equal(loadIssueCandidate("C1", "nope"), undefined); // missing → no log
    saveIssueCandidate(sample());
    fs.writeFileSync(issueCandidatePath("C1", "100.2"), "{ not json");
    const logs: string[] = [];
    assert.equal(loadIssueCandidate("C1", "100.2", (m) => logs.push(m)), undefined);
    assert.equal(logs.length, 1); // corrupt → logged once
  });

  it("claim is atomic: a second claim returns undefined", () => {
    saveIssueCandidate(sample());
    const first = claimIssueCandidate("C1", "100.2");
    assert.ok(first);
    assert.equal(first?.scope, "erp");
    const second = claimIssueCandidate("C1", "100.2");
    assert.equal(second, undefined);
  });

  it("release puts the record back so a later claim works", () => {
    saveIssueCandidate(sample());
    assert.ok(claimIssueCandidate("C1", "100.2"));
    assert.equal(releaseIssueCandidate("C1", "100.2"), true);
    assert.ok(claimIssueCandidate("C1", "100.2"));
  });

  it("finalize writes the url and commits to .json", () => {
    saveIssueCandidate(sample());
    assert.ok(claimIssueCandidate("C1", "100.2"));
    finalizeIssueCandidate("C1", "100.2", "https://github.com/o/r/issues/9");
    const after = loadIssueCandidate("C1", "100.2");
    assert.equal(after?.issuedUrl, "https://github.com/o/r/issues/9");
    assert.ok(!fs.existsSync(issueCandidatePath("C1", "100.2") + ".claiming"));
  });

  it("recover finalizes a .claiming that already has issuedUrl; warns on a bare one", () => {
    // claiming WITH url → recovered to .json, NOT a warning
    saveIssueCandidate(sample({ anchorTs: "100.3", issuedUrl: "https://x/1" }));
    const cp = issueCandidatePath("C1", "100.3");
    fs.renameSync(cp, cp + ".claiming");
    // bare claiming (no url) → warning
    saveIssueCandidate(sample({ anchorTs: "100.4" }));
    const bp = issueCandidatePath("C1", "100.4");
    fs.renameSync(bp, bp + ".claiming");

    const warnings: string[] = [];
    recoverIssueClaims(0, (m) => warnings.push(m)); // staleMs=0 → bare one is stale
    assert.ok(fs.existsSync(cp)); // finalized
    assert.equal(warnings.length, 1); // only the bare one warns
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd packages/cli && node --import tsx --test test/issue-candidate.test.ts`
Expected: FAIL — `Cannot find module '../src/gateway/issue-candidate'`.

- [ ] **Step 3: Implement `issue-candidate.ts`**

Create `packages/cli/src/gateway/issue-candidate.ts`:

```ts
/**
 * Durable, snapshot record for the confirmed-problem → GitHub issue flow.
 * Independent of the consumable escalation marker: it is NOT cleared when
 * a tech reply is absorbed, so the 🎫 path survives "reply first, react
 * later". Lifecycle is LOCK-THEN-FINALIZE (the lock must outlive an async,
 * non-idempotent `gh issue create`), distinct from claimThreadEscalation's
 * consume-on-claim.
 *
 * Files: <gatewayDir>/issue-candidates/<channelId>__<anchorTs>.json (0600).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { gatewayDir } from "./config";
import { assertSafeSegment } from "./session-store";

export interface IssueCandidate {
  channelId: string;
  threadTs: string;
  /** Bot escalation message ts — the exact 🎫 react target + storage key. */
  anchorTs: string;
  /** request.repo (always present — repo-less escalations write no candidate). */
  scope: string;
  askerUserId: string;
  /** Tech pool actually @-mentioned for THIS thread (authorization snapshot). */
  mentionedUserIds: string[];
  question: string;
  diagnosis: string;
  /** Best-effort Slack permalink of the anchor message. */
  permalink?: string;
  /** Set once the issue is created (idempotency / finalize commit). */
  issuedUrl?: string;
}

function issueCandidatesDir(): string {
  return path.join(gatewayDir(), "issue-candidates");
}

export function issueCandidatePath(channelId: string, anchorTs: string): string {
  return path.join(
    issueCandidatesDir(),
    `${assertSafeSegment(channelId, "channelId")}__${assertSafeSegment(anchorTs, "anchorTs")}.json`,
  );
}

function isIssueCandidate(v: unknown): v is IssueCandidate {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.channelId === "string" &&
    typeof o.threadTs === "string" &&
    typeof o.anchorTs === "string" &&
    typeof o.scope === "string" &&
    typeof o.askerUserId === "string" &&
    Array.isArray(o.mentionedUserIds) &&
    typeof o.question === "string" &&
    typeof o.diagnosis === "string"
  );
}

export function saveIssueCandidate(c: IssueCandidate): void {
  const file = issueCandidatePath(c.channelId, c.anchorTs);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(c, null, 2), { mode: 0o600 });
}

/**
 * Load a candidate. Missing file → undefined (silent). File present but
 * unparseable / failing the guard → undefined AND onLog is called once
 * (a corrupt record must be diagnosable, not a silent no-op).
 */
export function loadIssueCandidate(
  channelId: string,
  anchorTs: string,
  onLog?: (msg: string) => void,
): IssueCandidate | undefined {
  const file = issueCandidatePath(channelId, anchorTs);
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (isIssueCandidate(parsed)) return parsed;
    onLog?.(`issue-candidate ${channelId}__${anchorTs} failed validation`);
    return undefined;
  } catch {
    onLog?.(`issue-candidate ${channelId}__${anchorTs} is corrupt JSON`);
    return undefined;
  }
}

/**
 * Atomically claim by renaming .json → .claiming (POSIX-atomic; only one
 * caller wins). Returns the parsed candidate, or undefined if the rename
 * fails (already claimed / finalized / missing). Does NOT delete the lock.
 */
export function claimIssueCandidate(
  channelId: string,
  anchorTs: string,
): IssueCandidate | undefined {
  const file = issueCandidatePath(channelId, anchorTs);
  const claiming = `${file}.claiming`;
  try {
    fs.renameSync(file, claiming);
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(claiming, "utf8")) as unknown;
    return isIssueCandidate(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Release a claim: rename .claiming → .json. Returns false (logged by caller) on failure. */
export function releaseIssueCandidate(channelId: string, anchorTs: string): boolean {
  const file = issueCandidatePath(channelId, anchorTs);
  try {
    fs.renameSync(`${file}.claiming`, file);
    return true;
  } catch {
    return false;
  }
}

/** Finalize: write issuedUrl into the .claiming file, THEN rename → .json (commit). */
export function finalizeIssueCandidate(
  channelId: string,
  anchorTs: string,
  url: string,
): void {
  const file = issueCandidatePath(channelId, anchorTs);
  const claiming = `${file}.claiming`;
  const parsed = JSON.parse(fs.readFileSync(claiming, "utf8")) as IssueCandidate;
  const updated: IssueCandidate = { ...parsed, issuedUrl: url };
  fs.writeFileSync(claiming, JSON.stringify(updated, null, 2), { mode: 0o600 });
  fs.renameSync(claiming, file);
}

/**
 * Recovery sweep (called by doctor). For each *.claiming file:
 *  - has issuedUrl → finalize (rename to .json); the issue exists, never re-create.
 *  - no issuedUrl and older than staleMs → warn (possible orphan; verify on GitHub).
 */
export function recoverIssueClaims(
  staleMs: number,
  onWarn: (msg: string) => void,
): void {
  const dir = issueCandidatesDir();
  if (!fs.existsSync(dir)) return;
  const now = Date.now();
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".claiming")) continue;
    const claiming = path.join(dir, name);
    const finalName = claiming.replace(/\.claiming$/, "");
    try {
      const parsed = JSON.parse(fs.readFileSync(claiming, "utf8")) as IssueCandidate;
      if (parsed.issuedUrl) {
        fs.renameSync(claiming, finalName);
        continue;
      }
    } catch {
      /* unreadable claiming file — fall through to staleness check */
    }
    const ageMs = now - fs.statSync(claiming).mtimeMs;
    if (ageMs >= staleMs) {
      onWarn(`stale issue-candidate lock ${name} — verify on GitHub, then delete/restore`);
    }
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd packages/cli && node --import tsx --test test/issue-candidate.test.ts`
Expected: PASS (all 7 cases). Then `npm run typecheck:test` — no errors.

Note: if `assertSafeSegment` is not exported from `session-store.ts`, it is (recon confirmed `export function assertSafeSegment`). If a future refactor moves it, import from wherever it lives.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/issue-candidate.ts packages/cli/test/issue-candidate.test.ts
git commit -m "feat(gateway): issue-candidate durable store (lock-then-finalize, 0600, recover)"
```

---

## Task 6: Escalation writes the issue-candidate (diagnosis + permalink + affordance ordering)

**Files:**
- Modify: `packages/cli/src/gateway/slack/escalation.ts` (`escalate()` ~75-150)
- Modify: `packages/cli/src/gateway/slack/free-chat-turn.ts:336-356` (hoist `visible`, pass `diagnosis`)
- Test: `packages/cli/test/issue-escalation.test.ts` (new — constructs `EscalationCoordinator` directly, like `escalation.test.ts`)

Order in `escalate()`: post the @-mention FIRST (capture its `ts` = anchorTs), then — ONLY when `request.repo` is present — `chat.getPermalink`, `saveIssueCandidate`, and on success `chat.update` to append the 🎫 affordance. All of this is fail-soft: a failure logs and is swallowed; the primary escalation (mention + marker + audit) must be untouched.

- [ ] **Step 1: Write the failing integration test**

Create `packages/cli/test/issue-escalation.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WebClient } from "@slack/web-api";
import { EscalationCoordinator } from "../src/gateway/slack/escalation";
import { loadIssueCandidate } from "../src/gateway/issue-candidate";
import {
  GATEWAY_CONFIG_VERSION,
  type GatewayConfig,
} from "../src/gateway/config";
import type { LlmProvider } from "../src/llm";

const baseConfig = (): GatewayConfig => ({
  version: GATEWAY_CONFIG_VERSION,
  admins: [],
  blocklist: [],
  audience: { default: "biz", users: {}, channels: {}, domainExamples: { biz: [], pm: [] } },
  escalation: { default: ["U-IT"], repos: {} },
  slack: {},
});

function fakeWeb(rec: {
  posts: unknown[];
  updates: unknown[];
  permalinkThrows?: boolean;
}): WebClient {
  let n = 0;
  return {
    chat: {
      postMessage: async (a: unknown) => {
        rec.posts.push(a);
        n += 1;
        return { ok: true, ts: `200.${n}`, channel: "C1" };
      },
      update: async (a: unknown) => {
        rec.updates.push(a);
        return { ok: true };
      },
      getPermalink: async () => {
        if (rec.permalinkThrows) throw new Error("no scope");
        return { ok: true, permalink: "https://slack/permalink" };
      },
    },
  } as unknown as WebClient;
}

const fakeLlm = (): LlmProvider => ({}) as unknown as LlmProvider;

const coord = (web: WebClient) =>
  new EscalationCoordinator({
    web,
    config: baseConfig(),
    onLog: () => {},
    llm: fakeLlm(),
  });

describe("escalate writes an issue-candidate", () => {
  let home: string;
  const orig = process.env.HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-iss-esc-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    if (orig !== undefined) process.env.HOME = orig;
  });

  it("with a repo: stores snapshot (diagnosis+permalink) and appends 🎫 via chat.update", async () => {
    const rec = { posts: [] as unknown[], updates: [] as unknown[] };
    await coord(fakeWeb(rec)).escalate({
      channelId: "C1",
      threadTs: "100.1",
      askerUserId: "U-ASK",
      diagnosis: "root cause at a.rb:10",
      request: { repo: "erp", question: "why broken" },
    });
    const c = loadIssueCandidate("C1", "200.1"); // first post ts
    assert.ok(c, "candidate written");
    assert.equal(c?.diagnosis, "root cause at a.rb:10");
    assert.equal(c?.scope, "erp");
    assert.deepEqual(c?.mentionedUserIds, ["U-IT"]);
    assert.equal(c?.permalink, "https://slack/permalink");
    assert.equal(rec.updates.length, 1); // affordance appended
  });

  it("without a repo: NO candidate, NO chat.update (no dead 🎫)", async () => {
    const rec = { posts: [] as unknown[], updates: [] as unknown[] };
    await coord(fakeWeb(rec)).escalate({
      channelId: "C1",
      threadTs: "100.1",
      askerUserId: "U-ASK",
      diagnosis: "d",
      request: { question: "why broken" }, // no repo
    });
    assert.equal(loadIssueCandidate("C1", "200.1"), undefined);
    assert.equal(rec.updates.length, 0);
    assert.equal(rec.posts.length, 1); // primary escalation still happened
  });

  it("permalink failure is best-effort: candidate still written without permalink", async () => {
    const rec = { posts: [] as unknown[], updates: [] as unknown[], permalinkThrows: true };
    await coord(fakeWeb(rec)).escalate({
      channelId: "C1",
      threadTs: "100.1",
      askerUserId: "U-ASK",
      diagnosis: "d",
      request: { repo: "erp", question: "q" },
    });
    const c = loadIssueCandidate("C1", "200.1");
    assert.ok(c);
    assert.equal(c?.permalink, undefined);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd packages/cli && node --import tsx --test test/issue-escalation.test.ts`
Expected: FAIL — `escalate()` has no `diagnosis` param (TS error) and writes no candidate.

- [ ] **Step 3: Add `diagnosis` to `escalate()` and capture the anchor ts**

In `packages/cli/src/gateway/slack/escalation.ts`, change the `escalate()` signature (~line 75) to add `diagnosis`:

```ts
  async escalate(args: {
    channelId: string;
    threadTs: string;
    askerUserId: string;
    diagnosis: string;
    request: { repo?: string; question: string; reason?: string };
  }): Promise<void> {
```

Destructure `diagnosis` alongside the existing fields where the method body destructures `args`.

Change the @-mention `postMessage` call (~line 129) to CAPTURE the returned ts (it currently discards via `.catch`). Replace the `await web.chat.postMessage({...}).catch(...)` with:

```ts
    let anchorTs: string | undefined;
    try {
      const post = await web.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `${mentions} 想麻煩你補充，pmk 沒有足夠 context 回答這題：\n> ${request.question}${reasonLine}\n\n回覆時請記得 \`@pmk\` 一下（例：\`@pmk 答案是…\`），這樣 pmk 才接得到你的回覆並吸收成 knowledge atom，之後同樣問題就能直接答出來。`,
      });
      anchorTs = (post as { ts?: string }).ts;
    } catch (err) {
      onLog(`failed to post escalation mention: ${(err as Error).message}`);
    }
```

(Keep the exact text string identical to the original — only the capture changes.)

- [ ] **Step 4: Write the issue-candidate + affordance after `saveThreadEscalation`**

After the existing `saveThreadEscalation({...})` call (~line 149), add (note `effectivePool` and `anchorTs` are already in scope):

```ts
    // Confirmed-problem → issue: write a durable snapshot ONLY when the
    // escalation carries a repo (repo-less default-pool escalations get no
    // 🎫 path, since repo override is out of scope). Fail-soft throughout —
    // never disrupt the primary escalation above.
    if (request.repo && anchorTs) {
      try {
        const { saveIssueCandidate } = await import("../issue-candidate");
        let permalink: string | undefined;
        try {
          const pl = await web.chat.getPermalink({
            channel: channelId,
            message_ts: anchorTs,
          });
          permalink = (pl as { permalink?: string }).permalink;
        } catch (err) {
          onLog(`issue-candidate: getPermalink failed: ${(err as Error).message}`);
        }
        saveIssueCandidate({
          channelId,
          threadTs,
          anchorTs,
          scope: request.repo,
          askerUserId,
          mentionedUserIds: effectivePool,
          question: request.question,
          diagnosis,
          permalink,
        });
        await web.chat.update({
          channel: channelId,
          ts: anchorTs,
          text: `${mentions} 想麻煩你補充，pmk 沒有足夠 context 回答這題：\n> ${request.question}${reasonLine}\n\n_確認是問題的話，在這則訊息上 react 🎫 我就開 issue_\n\n回覆時請記得 \`@pmk\` 一下（例：\`@pmk 答案是…\`），這樣 pmk 才接得到你的回覆並吸收成 knowledge atom。`,
        });
      } catch (err) {
        onLog(`issue-candidate write failed (escalation unaffected): ${(err as Error).message}`);
      }
    }
```

Prefer a top-of-file `import { saveIssueCandidate } from "../issue-candidate";` over the dynamic `import()` if it does not create a cycle; if escalation.ts ↔ issue-candidate.ts has no cycle (it does not — issue-candidate imports only config + session-store), use the static import and drop the `await import(...)` line.

- [ ] **Step 5: Hoist `visible` and pass `diagnosis` from free-chat-turn**

In `packages/cli/src/gateway/slack/free-chat-turn.ts`, move the `const visible = ...` computation (currently lines 354-356) to ABOVE the `if (escReq)` block (line 337), and pass it into the call. Result:

```ts
    const visible = stripEscalateBlock(
      stripMraAskBlock(stripCaseUpdateBlock(full)),
    );

    const escReq = parseEscalate(full);
    if (escReq) {
      await this.opts.escalation.escalate({
        channelId,
        threadTs,
        askerUserId: userId,
        diagnosis: visible,
        request: escReq,
      });
      if (retrieved.length > 0) {
        bumpQuestioned(
          atomIds,
          `escalate:${channelId}:${threadTs}:${String(placeholder.ts)}`,
        );
      }
    }

    session.messages.push({ role: "assistant", content: visible });
```

(Delete the now-duplicate `const visible = ...` that was at line 354.)

- [ ] **Step 6: Run tests, verify they pass**

Run: `cd packages/cli && node --import tsx --test test/issue-escalation.test.ts`
Expected: PASS (3 cases). Then run the existing escalation suite to confirm no regression:
`node --import tsx --test test/escalation.test.ts` — expect green. Then `npm run typecheck:test`.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/gateway/slack/escalation.ts packages/cli/src/gateway/slack/free-chat-turn.ts packages/cli/test/issue-escalation.test.ts
git commit -m "feat(gateway): escalate() writes issue-candidate snapshot (diagnosis+permalink), gated on repo, 🎫 via chat.update"
```

---

## Task 7: `IssueCoordinator` + reaction dispatch (the 🎫 → issue flow)

**Files:**
- Create: `packages/cli/src/gateway/slack/issue.ts`
- Modify: `packages/cli/src/gateway/slack/index.ts` (options ~80-115; constructor ~270; `handleReactionAdded` gate ~783)
- Modify: `packages/cli/test/harness/slack-fakes.ts` (add `chat.getPermalink` to `FakeWebClient`; expose a `github` injection seam)
- Test: `packages/cli/test/issue-flow.test.ts` (new — uses `buildHarness`)

The handler implements the data-flow steps exactly: anchor match → issuedUrl idempotency → authorize (snapshot pool) → atomic claim → **gh availability (step e, before repoVisibility)** → slug → token → public-repo guard → build → createIssue → finalize → audit → best-effort reply. The releasable phase (claim..publicguard) auto-releases on early-return; createIssue/finalize are OUTSIDE it (failures leave `.claiming`).

- [ ] **Step 1: Add a `github` injection seam + `getPermalink` fake to the harness**

In `packages/cli/test/harness/slack-fakes.ts`, add `getPermalink` to the `FakeWebClient.chat` object (near `update`):

```ts
    getPermalink: async (_a: unknown) => ({ ok: true, permalink: "https://slack/permalink" }),
```

In `buildHarness`, allow passing fake github deps through to the adapter. Add an optional param and thread it into the `new SlackAdapter({...})` call:

```ts
export function buildHarness(opts: { github?: unknown } = {}) {
  // ...existing setup...
  const adapter = new SlackAdapter({
    // ...existing fields...
    github: opts.github as never,
  });
  // ...
}
```

- [ ] **Step 2: Write the failing integration tests**

Create `packages/cli/test/issue-flow.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { buildHarness, reactionAddedPayload } from "./harness/slack-fakes";
import { saveIssueCandidate, loadIssueCandidate, issueCandidatePath } from "../src/gateway/issue-candidate";
import { readGatewayEvents } from "../src/gateway/events";
import * as fs from "node:fs";

function fakeGithub(over: Record<string, unknown> = {}) {
  return {
    findGhBinary: () => "/usr/bin/gh",
    resolveRepoSlug: async () => "onead/erp",
    repoVisibility: async () => "private",
    createIssue: async () => "https://github.com/onead/erp/issues/5",
    ...over,
  };
}

const seedCandidate = (anchorTs: string, over = {}) =>
  saveIssueCandidate({
    channelId: "C1",
    threadTs: "100.1",
    anchorTs,
    scope: "erp",
    askerUserId: "U-ASK",
    mentionedUserIds: ["U-IT"],
    question: "why broken",
    diagnosis: "root cause a.rb:10",
    ...over,
  });

describe("🎫 issue flow", () => {
  let h: ReturnType<typeof buildHarness>;
  afterEach(() => h?.cleanup());

  async function react(anchorTs: string, user = "U-IT", reaction = "ticket") {
    await h.socket.emit(
      "reaction_added",
      reactionAddedPayload({ user, reaction, itemChannel: "C1", itemTs: anchorTs }),
    );
    await h.flush();
  }

  it("authorized 🎫 creates the issue from the snapshot, finalizes, audits", async () => {
    h = buildHarness({ github: fakeGithub() });
    seedCandidate("200.1");
    await h.adapter.start();
    await react("200.1");
    assert.equal(loadIssueCandidate("C1", "200.1")?.issuedUrl, "https://github.com/onead/erp/issues/5");
    const ev = readGatewayEvents().find((e) => e.type === "github.issue.created");
    assert.ok(ev);
  });

  it("reply-first then 🎫 still works (durable candidate survives)", async () => {
    // simulate: candidate exists even though no escalation marker (absorb consumed it)
    h = buildHarness({ github: fakeGithub() });
    seedCandidate("200.2");
    await h.adapter.start();
    await react("200.2");
    assert.ok(loadIssueCandidate("C1", "200.2")?.issuedUrl);
  });

  it("createIssue failure does NOT release (.claiming stays); second 🎫 no duplicate", async () => {
    let calls = 0;
    h = buildHarness({
      github: fakeGithub({
        createIssue: async () => {
          calls += 1;
          throw new Error("gh issue create failed (1)");
        },
      }),
    });
    seedCandidate("200.3");
    await h.adapter.start();
    await react("200.3");
    assert.ok(fs.existsSync(issueCandidatePath("C1", "200.3") + ".claiming"));
    await react("200.3"); // second attempt
    assert.equal(calls, 1); // claim fails second time → no duplicate createIssue
  });

  it("missing gh → reason=no-gh, claim released, repoVisibility/createIssue NOT called", async () => {
    let visCalled = false;
    h = buildHarness({
      github: fakeGithub({
        findGhBinary: () => undefined,
        repoVisibility: async () => {
          visCalled = true;
          return "private";
        },
      }),
    });
    seedCandidate("200.4");
    await h.adapter.start();
    await react("200.4");
    assert.equal(visCalled, false);
    assert.equal(fs.existsSync(issueCandidatePath("C1", "200.4") + ".claiming"), false); // released
    const ev = readGatewayEvents().find((e) => e.type === "github.issue.failed");
    assert.equal((ev as { reason?: string })?.reason, "no-gh");
  });

  it("public repo (allowPublicRepos default false) → blocked, released, reason=public-repo", async () => {
    h = buildHarness({ github: fakeGithub({ repoVisibility: async () => "public" }) });
    seedCandidate("200.5");
    await h.adapter.start();
    await react("200.5");
    assert.equal(loadIssueCandidate("C1", "200.5")?.issuedUrl, undefined);
    const ev = readGatewayEvents().find((e) => e.type === "github.issue.failed");
    assert.equal((ev as { reason?: string })?.reason, "public-repo");
  });

  it("unauthorized reactor (not in mentionedUserIds) is ignored", async () => {
    let created = false;
    h = buildHarness({ github: fakeGithub({ createIssue: async () => { created = true; return "x"; } }) });
    seedCandidate("200.6");
    await h.adapter.start();
    await react("200.6", "U-RANDO");
    assert.equal(created, false);
  });

  it("duplicate 🎫 after issued → existing URL, createIssue not called again", async () => {
    let calls = 0;
    h = buildHarness({
      github: fakeGithub({ createIssue: async () => { calls += 1; return "https://github.com/onead/erp/issues/9"; } }),
    });
    seedCandidate("200.7");
    await h.adapter.start();
    await react("200.7");
    await react("200.7");
    assert.equal(calls, 1);
  });

  it("🎫 with no candidate is ignored", async () => {
    h = buildHarness({ github: fakeGithub() });
    await h.adapter.start();
    await react("999.9"); // no candidate seeded
    assert.equal(readGatewayEvents().length, 0);
  });
});
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `cd packages/cli && node --import tsx --test test/issue-flow.test.ts`
Expected: FAIL — `ticket` reactions are dropped by the gate; no `IssueCoordinator`.

- [ ] **Step 4: Implement `IssueCoordinator`**

Create `packages/cli/src/gateway/slack/issue.ts`:

```ts
/**
 * The 🎫 → GitHub issue coordinator. Loads the durable issue-candidate
 * snapshot, authorizes the reactor against the snapshot pool, claims it
 * atomically, then resolves repo/token/visibility and opens the issue —
 * all from the snapshot (no Slack history reads). Lock-then-finalize:
 * the releasable phase auto-releases on early-return; createIssue/finalize
 * run OUTSIDE it so a post-create failure leaves .claiming for doctor.
 */
import type { WebClient } from "@slack/web-api";
import type { GatewayConfig } from "../config";
import { resolveGithubToken } from "../config";
import { appendGatewayEvent } from "../events";
import {
  loadIssueCandidate,
  claimIssueCandidate,
  releaseIssueCandidate,
  finalizeIssueCandidate,
  type IssueCandidate,
} from "../issue-candidate";
import {
  resolveRepoSlug as resolveRepoSlugImpl,
  repoVisibility as repoVisibilityImpl,
  createIssue as createIssueImpl,
  findGhBinary as findGhBinaryImpl,
} from "../../adapters/github";

export interface GithubGateway {
  findGhBinary: typeof findGhBinaryImpl;
  resolveRepoSlug: typeof resolveRepoSlugImpl;
  repoVisibility: typeof repoVisibilityImpl;
  createIssue: typeof createIssueImpl;
}

export const realGithubGateway: GithubGateway = {
  findGhBinary: findGhBinaryImpl,
  resolveRepoSlug: resolveRepoSlugImpl,
  repoVisibility: repoVisibilityImpl,
  createIssue: createIssueImpl,
};

export interface IssueCoordinatorOptions {
  web: WebClient;
  config: GatewayConfig;
  onLog: (msg: string) => void;
  github: GithubGateway;
}

export class IssueCoordinator {
  constructor(private readonly opts: IssueCoordinatorOptions) {}

  private async reply(channel: string, threadTs: string, text: string): Promise<void> {
    try {
      await this.opts.web.chat.postMessage({ channel, thread_ts: threadTs, text });
    } catch (err) {
      this.opts.onLog(`issue: reply failed (non-fatal): ${(err as Error).message}`);
    }
  }

  /** Handle a 🎫 reaction on `anchorTs` in `channelId` from `reactorUserId`. */
  async fromCandidate(args: {
    channelId: string;
    anchorTs: string;
    reactorUserId: string;
  }): Promise<void> {
    const { channelId, anchorTs, reactorUserId } = args;
    const { config, github, onLog } = this.opts;

    // (a) anchor match — load by channel+anchorTs; corrupt is logged, not silent.
    const candidate = loadIssueCandidate(channelId, anchorTs, onLog);
    if (!candidate) return;

    // (b) idempotency: already issued → repost URL, stop.
    if (candidate.issuedUrl) {
      await this.reply(channelId, candidate.threadTs, `已開過 issue：${candidate.issuedUrl}`);
      return;
    }

    // (c) authorize against the snapshot pool + blocklist.
    const authorized =
      candidate.mentionedUserIds.includes(reactorUserId) &&
      !config.blocklist.includes(reactorUserId);
    if (!authorized) {
      onLog(`issue: unauthorized 🎫 from ${reactorUserId} on ${channelId}__${anchorTs}`);
      return;
    }

    // (d) atomic claim — the true serializer.
    const claimed = claimIssueCandidate(channelId, anchorTs);
    if (!claimed) return; // someone else holds/finalized it

    // Releasable phase (e..g): auto-release on any early-return / throw.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (!releaseIssueCandidate(channelId, anchorTs)) {
        onLog(`issue: FAILED to release claim ${channelId}__${anchorTs}`);
      }
    };
    const failAudit = (reason: string, repo?: string) =>
      appendGatewayEvent({ type: "github.issue.failed", actor: reactorUserId, repo, reason });

    let slug: string;
    let token: string;
    try {
      // (e) gh availability FIRST — before anything that shells to gh.
      if (!github.findGhBinary()) {
        await this.reply(channelId, candidate.threadTs, "host 需要安裝 gh CLI，未開 issue");
        failAudit("no-gh");
        release();
        return;
      }
      const maybeSlug = await github.resolveRepoSlug(
        config.mraWorkspace ?? "",
        candidate.scope,
      );
      if (!maybeSlug) {
        await this.reply(channelId, candidate.threadTs, "無法從該 repo 的 git origin 推出 GitHub slug，未開 issue");
        failAudit("slug");
        release();
        return;
      }
      slug = maybeSlug;

      // (f) token.
      const maybeToken = resolveGithubToken(config.github);
      if (!maybeToken) {
        await this.reply(channelId, candidate.threadTs, "GitHub token 未設定 / 指令失敗，未開 issue");
        failAudit("token", slug);
        release();
        return;
      }
      token = maybeToken;

      // (g) public-repo guard.
      if (config.github?.allowPublicRepos !== true) {
        const vis = await github.repoVisibility({ slug, token });
        if (vis !== "private") {
          await this.reply(
            channelId,
            candidate.threadTs,
            "目標 repo 為 public（或無法判定），已停止以免內部資訊外洩。請改用 private repo 或開啟 allowPublicRepos",
          );
          failAudit("public-repo", slug);
          release();
          return;
        }
      }
    } catch (err) {
      onLog(`issue: pre-create error, releasing: ${(err as Error).message}`);
      failAudit("gh-create-failed");
      release();
      return;
    }

    // OUTSIDE the releasable phase — createIssue + finalize. A failure here
    // does NOT release (GitHub may have accepted it): leave .claiming.
    let url: string;
    try {
      url = await github.createIssue({
        slug,
        title: buildTitle(candidate),
        body: buildBody(candidate, slug),
        token,
      });
    } catch (err) {
      onLog(`issue: createIssue failed (claim left for doctor): ${(err as Error).message}`);
      await this.reply(channelId, candidate.threadTs, "開 issue 失敗，請稍後重試或由 host 檢查");
      failAudit("gh-create-failed", slug);
      return; // NOTE: no release()
    }

    finalizeIssueCandidate(channelId, anchorTs, url);
    appendGatewayEvent({ type: "github.issue.created", actor: reactorUserId, repo: slug, url });
    await this.reply(channelId, candidate.threadTs, `已開 issue：${url}`);
  }
}

function buildTitle(c: IssueCandidate): string {
  const firstLine = c.question.split("\n")[0].slice(0, 80);
  return `[pmk] ${firstLine}`;
}

function buildBody(c: IssueCandidate, slug: string): string {
  const source = c.permalink
    ? `- Slack thread: ${c.permalink}`
    : `- Slack: channel ${c.channelId} thread ${c.threadTs}`;
  return [
    "## 問題（使用者回報）",
    c.question,
    "",
    "## 診斷（pmk grounded）",
    c.diagnosis,
    "",
    "## 來源",
    source,
    `- 提問者：<@${c.askerUserId}>`,
    `- repo: ${slug}`,
  ].join("\n");
}
```

Note: the spec mentions an LLM call to compose title/問題/診斷/建議方向 from the snapshot. This plan builds the body deterministically from the snapshot fields (snapshot-only, no thread reads) — simpler, no extra LLM dependency in the hot path, and fully testable. An LLM-polished body is a later enhancement (YAGNI for v1).

- [ ] **Step 5: Wire `github` into `SlackAdapterOptions` and construct `IssueCoordinator`**

In `packages/cli/src/gateway/slack/index.ts`:

Add the import near the other slack imports (~line 34):
```ts
import { IssueCoordinator, realGithubGateway, type GithubGateway } from "./issue";
```

Add to `interface SlackAdapterOptions` (~line 115, near `runMraAsk?`):
```ts
  /** v0.25 harness DI: override the gh-CLI gateway so the 🎫→issue flow
   * runs without spawning a real process or needing gh on PATH. */
  github?: GithubGateway;
```

Add a private field + assignment in the constructor (near `this.runMraAsk = ...` ~line 237):
```ts
  private readonly issue: IssueCoordinator;
```
and after the `this.escalation = new EscalationCoordinator({...})` block (~line 275):
```ts
    this.issue = new IssueCoordinator({
      web: this.web,
      config: this.config,
      onLog: this.onLog,
      github: opts.github ?? realGithubGateway,
    });
```

- [ ] **Step 6: Widen the reaction gate + dispatch `ticket`**

In `handleReactionAdded` (`packages/cli/src/gateway/slack/index.ts` ~line 774-788), add an `isTicket` flag and dispatch BEFORE the existing approve/reject logic. After the `const isCitationFeedback = ...` line and BEFORE the gate at line 783:

```ts
    const isTicket = reaction === "ticket";
```

Change the gate (line 783) to:
```ts
    if (!isApprove && !isReject && !isCitationFeedback && !isTicket) return;
```

Then, after the field reads (`channelId`/`messageTs`/`reactorUserId`, ~line 788), add the ticket dispatch as the first branch:
```ts
    if (isTicket) {
      await this.issue.fromCandidate({
        channelId,
        anchorTs: messageTs,
        reactorUserId,
      });
      return;
    }
```

- [ ] **Step 7: Run tests, verify they pass**

Run: `cd packages/cli && node --import tsx --test test/issue-flow.test.ts`
Expected: PASS (8 cases). Then run the existing reaction suite to confirm the gate change didn't break approvals:
`node --import tsx --test test/slack-adapter.test.ts` — expect green. Then `npm run typecheck:test`.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/gateway/slack/issue.ts packages/cli/src/gateway/slack/index.ts packages/cli/test/harness/slack-fakes.ts packages/cli/test/issue-flow.test.ts
git commit -m "feat(gateway): IssueCoordinator + 🎫 dispatch — claim/gh-check/slug/token/public-guard/create/finalize/audit"
```

---

## Task 8: Doctor — `github-token` check + stale-claim recovery

**Files:**
- Create: `packages/cli/src/gateway/doctor-checks/github-token.ts`
- Modify: `packages/cli/src/gateway/doctor-checks/index.ts` (export + add to `DEFAULT_CHECKS`)
- Test: `packages/cli/test/doctor-github.test.ts`

A new `DoctorCheck` mirroring `secret-sources.ts`. When `github` is unconfigured it PASSes (the 🎫 flow is simply off). When configured: gh present + token resolves → pass; missing → fail. It also runs `recoverIssueClaims` (10-min staleness) and surfaces any stale-lock as a `warn` line. (The public-repo doctor warning is deliberately deferred — the runtime public-repo guard in `IssueCoordinator` is the actual leak protection; a configured-repo visibility sweep is a follow-up.)

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/doctor-github.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { githubTokenCheck } from "../src/gateway/doctor-checks/github-token";
import type { DoctorContext } from "../src/gateway/doctor";
import { GATEWAY_CONFIG_VERSION, type GatewayConfig } from "../src/gateway/config";

const cfg = (over: Partial<GatewayConfig> = {}): GatewayConfig => ({
  version: GATEWAY_CONFIG_VERSION,
  admins: [],
  blocklist: [],
  audience: { default: "biz", users: {}, channels: {}, domainExamples: { biz: [], pm: [] } },
  escalation: { default: [], repos: {} },
  slack: {},
  ...over,
});

const ctx = (config: GatewayConfig | null): DoctorContext =>
  ({ config } as unknown as DoctorContext);

describe("github-token doctor check", () => {
  let home: string;
  const orig = process.env.HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-doc-gh-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    if (orig !== undefined) process.env.HOME = orig;
  });

  it("passes when github is unconfigured", async () => {
    const r = await githubTokenCheck(ctx(cfg()));
    assert.equal(r.severity, "pass");
    assert.match(r.message, /not configured|off/i);
  });

  it("fails when github.token unset/unresolved but github present", async () => {
    // a {cmd} that cannot resolve (PMK_SKIP_GH_PROBE forces no gh too)
    process.env.PMK_SKIP_GH_PROBE = "1";
    const r = await githubTokenCheck(ctx(cfg({ github: { token: { env: "PMK_NO_SUCH_VAR" } } })));
    process.env.PMK_SKIP_GH_PROBE = "";
    assert.equal(r.severity, "fail");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd packages/cli && node --import tsx --test test/doctor-github.test.ts`
Expected: FAIL — `Cannot find module '.../github-token'`.

- [ ] **Step 3: Implement `github-token.ts`**

Create `packages/cli/src/gateway/doctor-checks/github-token.ts`:

```ts
import type { DoctorCheck, DoctorCheckResult } from "../doctor";
import { resolveGithubToken } from "../config";
import { findGhBinary } from "../../adapters/github";
import { recoverIssueClaims } from "../issue-candidate";

const STALE_LOCK_MS = 10 * 60 * 1000;

/**
 * github-token check for the confirmed-problem → issue flow. PASSes when
 * github is unconfigured (flow off). When configured: gh present + token
 * resolves → pass, else fail. Also self-heals issue-candidate claim locks
 * (finalizes claiming-with-url; warns on stale bare locks). Never prints the token.
 */
export const githubTokenCheck: DoctorCheck = async (
  ctx,
): Promise<DoctorCheckResult> => {
  const github = ctx.config?.github;
  const warnings: string[] = [];
  recoverIssueClaims(STALE_LOCK_MS, (m) => warnings.push(m));

  if (!github) {
    return {
      name: "github-token",
      severity: warnings.length ? "warn" : "pass",
      message: warnings.length
        ? `github not configured (🎫 issue flow off); ${warnings.join("; ")}`
        : "github not configured (🎫 issue flow off)",
    };
  }

  const ghPresent = !!findGhBinary();
  let token: string | undefined;
  let tokenError: string | undefined;
  try {
    token = resolveGithubToken(github);
  } catch (e) {
    tokenError = (e as Error).message; // SecretResolutionError — no stdout/stderr in it
  }

  const problems: string[] = [];
  if (!ghPresent) problems.push("gh CLI not found on PATH");
  if (tokenError) problems.push(tokenError);
  else if (!token) problems.push("github.token unset / unresolved");

  const detail = [
    `gh=${ghPresent ? "found" : "missing"}`,
    `token=${token ? "resolved" : "unresolved"}`,
    ...warnings,
  ].join("; ");

  return {
    name: "github-token",
    severity: problems.length ? "fail" : warnings.length ? "warn" : "pass",
    message: problems.length ? `${detail} — ${problems.join("; ")}` : detail,
  };
};
```

- [ ] **Step 4: Register the check**

In `packages/cli/src/gateway/doctor-checks/index.ts`: add `import { githubTokenCheck } from "./github-token";`, add `githubTokenCheck` to the `export { ... }` block, and append it to `DEFAULT_CHECKS` (after `manifestAlignmentCheck` is fine — or before it; order only affects output legibility):

```ts
  manifestAlignmentCheck,
  githubTokenCheck,
];
```

- [ ] **Step 5: Run tests, verify they pass**

Run: `cd packages/cli && node --import tsx --test test/doctor-github.test.ts`
Expected: PASS. Then run the existing doctor suite (if any, e.g. `test/doctor.test.ts`) — expect green. Then `npm run typecheck:test`.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/gateway/doctor-checks/github-token.ts packages/cli/src/gateway/doctor-checks/index.ts packages/cli/test/doctor-github.test.ts
git commit -m "feat(gateway): doctor github-token check + issue-claim self-heal sweep"
```

---

## Task 9: Full suite + typecheck + final review

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `cd packages/cli && npm test`
Expected: all suites PASS (including the new github / issue-candidate / issue-flow / issue-escalation / events / config / escalate-parser / doctor-github tests), and `typecheck:test` clean.

- [ ] **Step 2: Build the CLI**

Run: `npm run cli:build` (from repo root)
Expected: TypeScript build succeeds with no errors. (If a stale `dist/` shadows a renamed file, `rm -rf packages/cli/dist` and rebuild — known monorepo gotcha.)

- [ ] **Step 3: Dispatch a final code review**

Use superpowers:requesting-code-review (or the everything-claude-code:typescript-reviewer agent) over the whole diff `git diff main...HEAD`. Focus: no-leak (token never in a reply/log/event), the lock-then-finalize release boundary (createIssue failures must NOT release), and the reaction-gate change not regressing approvals. Address CRITICAL/HIGH findings before finishing.

- [ ] **Step 4: Finish the branch**

Use superpowers:finishing-a-development-branch.

---

## Self-Review (author checklist — completed)

**1. Spec coverage:**
- Adapter (`github.ts`): findGhBinary/resolveRepoSlug/repoVisibility/createIssue/githubDoctor → Task 1. ✅
- Config (`github.token` + `allowPublicRepos` + resolveGithubToken) → Task 2. ✅
- Events (created/failed token-free payloads) → Task 3. ✅
- Parser nested-repo (`safeRepoHint`) → Task 4. ✅
- Durable record + lock-then-finalize + recover → Task 5. ✅
- Escalate plumbing (diagnosis, anchorTs, permalink, gated candidate, affordance ordering) → Task 6. ✅
- 🎫 handler (anchor match, idempotency, snapshot authz, claim, gh-before-visibility, slug, token, public-guard, build, createIssue, finalize, audit-before-reply, release boundary) + gate widening → Task 7. ✅
- Doctor github-token + stale-claim self-heal → Task 8. ✅
- **Deferred (documented):** public-repo doctor *warning* sweep (runtime guard covers the actual leak); LLM-polished issue body (deterministic snapshot body shipped instead, YAGNI).

**2. Placeholder scan:** none — every code step has complete code; every run step has a command + expected outcome.

**3. Type consistency:** `GithubExec`/`GithubDeps` (Task 1) reused in Task 7's `GithubGateway` via `typeof` of the real impls. `IssueCandidate` fields (Task 5) match the writer (Task 6) and reader (Task 7). `escalate()`'s new `diagnosis` param (Task 6 step 3) matches the caller (Task 6 step 5). `resolveGithubToken(config.github)` signature (Task 2) matches its call in Task 7 and Task 8. Event types `github.issue.created`/`github.issue.failed` (Task 3) match every `appendGatewayEvent` call (Task 7).
