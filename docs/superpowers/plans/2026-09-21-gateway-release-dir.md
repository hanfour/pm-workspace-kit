# Gateway Release Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live gateway run from `~/.pmk/releases/current`, built from a git commit, so a build in the repo can no longer rewrite production.

**Architecture:** `pmk gateway deploy <ref>` exports a commit with `git archive` into a staging directory, installs and builds four workspaces there, smoke-tests the result, promotes it to `~/.pmk/releases/<version>-<sha7>/`, flips a `current` symlink and restarts the LaunchAgent. If the new process does not reach `phase: "ready"` in 60 s the links are restored and the service restarted again. All process and filesystem-root access is injected so the logic is unit-testable under an isolated HOME.

**Tech Stack:** TypeScript (CommonJS build via `tsc`), `node:test` + `node:assert/strict` run through `tsx`, `execFileSync` (no shell), launchd.

**Spec:** `docs/superpowers/specs/2026-09-21-gateway-release-dir-design.md`

## Global Constraints

- Work on branch `feat/gateway-release-dir`. All paths below are relative to `packages/cli/` unless they start with `docs/` or `apps/`.
- **Never run `npm run build`, `npm run cli:build`, or any workspace `build` script in this checkout.** The live gateway still runs this checkout's `dist` until Task 9 completes. Tests do not need a build: they run from source through `tsx`.
- Run one test file: `node --import tsx --test test/<file>.test.ts` (from `packages/cli/`). Run everything: `npm test --workspace=packages/cli` (from the repo root; includes `typecheck:test`).
- Any test that touches the filesystem under `~` must call `useIsolatedHome()` from `test/helpers/isolated-home.ts`. Never set `process.env.HOME` back to the real home.
- Every external command goes through `execFile`/`execFileSync` with an argument array. No shell strings.
- No mutation of inputs; return new objects. Files stay under 200 lines, functions under 50.
- Release name format: `<package.json version>-<first 7 chars of sha>`. Releases root: `~/.pmk/releases`. Entry point inside a release: `packages/cli/dist/index.js`.
- Install scope: `packages/cli`, `packages/llm`, `packages/rag`, `packages/shared`. Build order: `@pmk/shared`, `@pmk/rag`, `@pmk/llm`, `@pmk/cli`.
- Ready timeout: 60 polls of 1 s. Retention: 3 releases total, never removing `current` or `previous`.
- Commit messages follow `<type>: <description>` and end with the `Co-Authored-By` trailer in use for this session.

## File Structure

| File | Responsibility |
|---|---|
| `src/gateway/deploy/paths.ts` (new) | releases root, naming, validators, `current`/`previous` links, `RELEASE.json` I/O, listing |
| `src/gateway/deploy/build.ts` (new) | resolve ref → export → install → build → smoke test → promote |
| `src/gateway/deploy/activate.ts` (new) | link flip, restart, ready poll, rollback |
| `src/gateway/deploy/prune.ts` (new) | retention |
| `src/commands/gateway/deploy.ts` (new) | `deploy` / `activate` / `rollback` argument parsing, real deps, output, event |
| `src/gateway/doctor-checks/release-entry.ts` (new) | doctor check on the plist entry point |
| `src/gateway/events.ts` (modify) | `gateway.deployed` / `gateway.rollback` event |
| `src/commands/gateway/ops.ts` (modify) | export `restartGateway()`; add release line to status |
| `src/commands/gateway/service.ts` (modify) | entry-point resolution |
| `src/commands/gateway/index.ts` (modify) | route the three new subcommands |

---

### Task 1: Release paths, naming and links

**Files:**
- Create: `src/gateway/deploy/paths.ts`
- Test: `test/gateway-deploy-paths.test.ts`

**Interfaces:**
- Consumes: `assertSafeBranch(branch: string): void` from `src/commands/worktree.ts`
- Produces:
  - `ENTRY_RELATIVE: string`, `RELEASE_INFO_FILE: string`
  - `type ReleaseLink = "current" | "previous"`
  - `interface ReleaseInfo { ref: string; sha: string; version: string; builtAt: string; nodeVersion: string }`
  - `releasesRoot(home?: string): string`
  - `releaseName(version: string, sha: string): string`
  - `assertSafeRef(ref: string): void`, `assertSafeReleaseName(name: string): void`
  - `releaseDir(root: string, name: string): string`, `stagingDir(root: string, sha: string): string`, `currentEntry(root: string): string`
  - `readLink(root: string, which: ReleaseLink): string | undefined`
  - `pointLink(root: string, which: ReleaseLink, name: string): void`
  - `writeReleaseInfo(dir: string, info: ReleaseInfo): void`, `readReleaseInfo(dir: string): ReleaseInfo | undefined`
  - `listReleases(root: string): string[]` — oldest first

- [ ] **Step 1: Write the failing test**

`test/gateway-deploy-paths.test.ts`:

```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { useIsolatedHome } from "./helpers/isolated-home";
import {
  ENTRY_RELATIVE, assertSafeRef, assertSafeReleaseName, currentEntry, listReleases,
  pointLink, readLink, readReleaseInfo, releaseDir, releaseName, releasesRoot,
  stagingDir, writeReleaseInfo,
} from "../src/gateway/deploy/paths";

const SHA = "2fa1497aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function makeRelease(root: string, name: string, builtAt: string): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  writeReleaseInfo(dir, { ref: "HEAD", sha: SHA, version: "0.44.0", builtAt, nodeVersion: "v22.21.1" });
}

describe("deploy paths", () => {
  const home = useIsolatedHome("pmk-deploy-paths-");

  it("releasesRoot is ~/.pmk/releases", () => {
    assert.equal(releasesRoot(home.dir()), path.join(home.dir(), ".pmk", "releases"));
  });

  it("releaseName joins version and the 7-char sha", () => {
    assert.equal(releaseName("0.44.0", SHA), "0.44.0-2fa1497");
  });

  it("currentEntry and stagingDir are derived from the root", () => {
    assert.equal(currentEntry("/r"), path.join("/r", "current", ENTRY_RELATIVE));
    assert.equal(stagingDir("/r", SHA), path.join("/r", ".staging-2fa1497"));
  });

  it("assertSafeReleaseName rejects traversal, flags and dotfiles", () => {
    for (const bad of ["", "..", "../x-2fa1497", "-rf-2fa1497", ".staging-2fa1497", "0.44.0", "0.44.0-XYZ1234", "a/b-2fa1497"]) {
      assert.throws(() => assertSafeReleaseName(bad), /invalid release name/, bad);
    }
    assert.doesNotThrow(() => assertSafeReleaseName("0.44.0-2fa1497"));
    assert.doesNotThrow(() => assertSafeReleaseName("1.0.0-rc.1-abcdef0"));
  });

  it("releaseDir refuses an unsafe name", () => {
    assert.throws(() => releaseDir("/r", "../etc-2fa1497"), /invalid release name/);
  });

  it("assertSafeRef rejects flag-like and shell-special refs", () => {
    for (const bad of ["", "-x", "a b", "a;b", "a..b", "$(id)"]) {
      assert.throws(() => assertSafeRef(bad), undefined, bad);
    }
    for (const ok of ["HEAD", "main", "v0.44.0", "feat/x", SHA]) {
      assert.doesNotThrow(() => assertSafeRef(ok), ok);
    }
  });

  it("readLink is undefined before any deploy; pointLink creates then replaces", () => {
    const root = releasesRoot(home.dir());
    fs.mkdirSync(root, { recursive: true });
    assert.equal(readLink(root, "current"), undefined);
    makeRelease(root, "0.44.0-2fa1497", "2026-09-21T00:00:00.000Z");
    makeRelease(root, "0.45.0-abcdef0", "2026-09-22T00:00:00.000Z");
    pointLink(root, "current", "0.44.0-2fa1497");
    assert.equal(readLink(root, "current"), "0.44.0-2fa1497");
    pointLink(root, "current", "0.45.0-abcdef0");
    assert.equal(readLink(root, "current"), "0.45.0-abcdef0");
    assert.ok(fs.lstatSync(path.join(root, "current")).isSymbolicLink());
    assert.ok(fs.existsSync(path.join(root, "current", "RELEASE.json")), "link resolves into the release");
    assert.deepEqual(fs.readdirSync(root).filter((n) => n.includes(".tmp-")), [], "no temp link left behind");
  });

  it("release info round-trips; a missing or corrupt file reads as undefined", () => {
    const root = releasesRoot(home.dir());
    makeRelease(root, "0.44.0-2fa1497", "2026-09-21T00:00:00.000Z");
    assert.equal(readReleaseInfo(path.join(root, "0.44.0-2fa1497"))?.sha, SHA);
    assert.equal(readReleaseInfo(path.join(root, "nope-2fa1497")), undefined);
    fs.writeFileSync(path.join(root, "0.44.0-2fa1497", "RELEASE.json"), "{not json");
    assert.equal(readReleaseInfo(path.join(root, "0.44.0-2fa1497")), undefined);
  });

  it("listReleases returns built releases oldest first, skipping links, staging and unbuilt dirs", () => {
    const root = releasesRoot(home.dir());
    makeRelease(root, "0.45.0-abcdef0", "2026-09-22T00:00:00.000Z");
    makeRelease(root, "0.44.0-2fa1497", "2026-09-21T00:00:00.000Z");
    fs.mkdirSync(path.join(root, ".staging-1234567"));
    fs.mkdirSync(path.join(root, "0.46.0-1111111")); // no RELEASE.json
    pointLink(root, "current", "0.45.0-abcdef0");
    assert.deepEqual(listReleases(root), ["0.44.0-2fa1497", "0.45.0-abcdef0"]);
  });

  it("listReleases on a missing root is empty", () => {
    assert.deepEqual(listReleases(path.join(home.dir(), "absent")), []);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/gateway-deploy-paths.test.ts`
Expected: FAIL — `Cannot find module '../src/gateway/deploy/paths'`

- [ ] **Step 3: Write the implementation**

`src/gateway/deploy/paths.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && node --import tsx --test test/gateway-deploy-paths.test.ts`
Expected: PASS, 10 tests.

Then: `npm run typecheck:test --workspace=packages/cli` (from the repo root). Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/deploy/paths.ts packages/cli/test/gateway-deploy-paths.test.ts
git commit -m "feat(deploy): release paths, naming and current/previous links"
```

---

### Task 2: Build a release from a commit

**Files:**
- Create: `src/gateway/deploy/build.ts`
- Test: `test/gateway-deploy-build.test.ts`

**Interfaces:**
- Consumes (Task 1): `ENTRY_RELATIVE`, `RELEASE_INFO_FILE`, `assertSafeRef`, `releaseDir`, `releaseName`, `stagingDir`, `writeReleaseInfo`
- Produces:
  - `interface BuildDeps { run(file: string, args: string[], cwd: string): string; exportTree(repo: string, sha: string, dest: string): void; now(): Date; nodeVersion: string; nodePath: string }`
  - `interface BuildResult { name: string; dir: string; sha: string; version: string; reused: boolean }`
  - `buildRelease(a: { repo: string; ref: string; root: string }, d: BuildDeps): BuildResult`
  - `INSTALL_WORKSPACES`, `BUILD_WORKSPACES` (readonly string arrays)

`run` returns stdout and throws on a non-zero exit. `exportTree` writes the tracked files of `sha` into `dest`.

- [ ] **Step 1: Write the failing test**

`test/gateway-deploy-build.test.ts`:

```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { useIsolatedHome } from "./helpers/isolated-home";
import { buildRelease, type BuildDeps } from "../src/gateway/deploy/build";
import { readReleaseInfo, releasesRoot } from "../src/gateway/deploy/paths";

const SHA = "2fa1497aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

interface Call { file: string; args: string[]; cwd: string }

/** Fake toolchain. `failOn` makes the first matching command throw. */
function fakeDeps(o: { failOn?: (c: Call) => boolean; versionOutput?: string } = {}): { deps: BuildDeps; calls: Call[] } {
  const calls: Call[] = [];
  const deps: BuildDeps = {
    nodeVersion: "v22.21.1",
    nodePath: "/usr/bin/node",
    now: () => new Date("2026-09-21T08:00:00.000Z"),
    exportTree: (_repo, _sha, dest) => {
      fs.writeFileSync(path.join(dest, "package.json"), JSON.stringify({ version: "0.44.0" }));
    },
    run: (file, args, cwd) => {
      const call = { file, args, cwd };
      calls.push(call);
      if (o.failOn?.(call)) throw new Error(`${file} ${args.join(" ")} failed`);
      if (file === "git" && args[0] === "rev-parse") return `${SHA}\n`;
      if (file === "git" && args[0] === "show") return JSON.stringify({ version: "0.44.0" });
      if (args.includes("--version")) return `${o.versionOutput ?? "0.44.0"}\n`;
      return "";
    },
  };
  return { deps, calls };
}

describe("buildRelease", () => {
  const home = useIsolatedHome("pmk-deploy-build-");
  const args = () => ({ repo: "/repo", ref: "HEAD", root: releasesRoot(home.dir()) });

  it("resolves, exports, installs the four workspaces, builds in CI order, smoke-tests, promotes", () => {
    const { deps, calls } = fakeDeps();
    const r = buildRelease(args(), deps);
    assert.deepEqual({ name: r.name, sha: r.sha, version: r.version, reused: r.reused },
      { name: "0.44.0-2fa1497", sha: SHA, version: "0.44.0", reused: false });
    assert.ok(fs.existsSync(path.join(r.dir, "package.json")), "exported tree was promoted");
    assert.deepEqual(readReleaseInfo(r.dir), {
      ref: "HEAD", sha: SHA, version: "0.44.0", builtAt: "2026-09-21T08:00:00.000Z", nodeVersion: "v22.21.1",
    });
    assert.deepEqual(calls[0].args, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const npm = calls.filter((c) => c.file === "npm").map((c) => c.args.join(" "));
    assert.deepEqual(npm, [
      "ci -w packages/cli -w packages/llm -w packages/rag -w packages/shared --no-audit --no-fund",
      "run build --workspace=@pmk/shared",
      "run build --workspace=@pmk/rag",
      "run build --workspace=@pmk/llm",
      "run build --workspace=@pmk/cli",
    ]);
    const smoke = calls.filter((c) => c.file === "/usr/bin/node").map((c) => c.args.slice(1).join(" "));
    assert.deepEqual(smoke, ["--version", "gateway status"]);
    assert.deepEqual(fs.readdirSync(args().root).filter((n) => n.startsWith(".staging-")), []);
  });

  it("reuses an already-built release without running npm", () => {
    buildRelease(args(), fakeDeps().deps);
    const second = fakeDeps();
    const r = buildRelease(args(), second.deps);
    assert.equal(r.reused, true);
    assert.equal(second.calls.filter((c) => c.file === "npm").length, 0);
  });

  it("rejects an unsafe ref before touching git", () => {
    const { deps, calls } = fakeDeps();
    assert.throws(() => buildRelease({ ...args(), ref: "--upload-pack=x" }, deps));
    assert.equal(calls.length, 0);
  });

  it("rejects a rev-parse result that is not a full sha", () => {
    const { deps } = fakeDeps();
    const bad: BuildDeps = { ...deps, run: (f, a, c) => (a[0] === "rev-parse" ? "HEAD\n" : deps.run(f, a, c)) };
    assert.throws(() => buildRelease(args(), bad), /could not resolve/);
  });

  for (const [label, failOn] of [
    ["npm ci", (c: Call) => c.file === "npm" && c.args[0] === "ci"],
    ["a build", (c: Call) => c.args.includes("--workspace=@pmk/llm")],
    ["gateway status", (c: Call) => c.args.includes("status")],
  ] as const) {
    it(`a failing ${label} removes staging and promotes nothing`, () => {
      assert.throws(() => buildRelease(args(), fakeDeps({ failOn }).deps));
      assert.deepEqual(fs.readdirSync(args().root), []);
    });
  }

  it("a --version mismatch fails the smoke test", () => {
    assert.throws(() => buildRelease(args(), fakeDeps({ versionOutput: "0.43.0" }).deps), /printed 0\.43\.0, expected 0\.44\.0/);
    assert.deepEqual(fs.readdirSync(args().root), []);
  });

  it("replaces a half-promoted directory that has no RELEASE.json", () => {
    const leftover = path.join(args().root, "0.44.0-2fa1497");
    fs.mkdirSync(leftover, { recursive: true });
    fs.writeFileSync(path.join(leftover, "junk"), "x");
    const r = buildRelease(args(), fakeDeps().deps);
    assert.equal(r.reused, false);
    assert.equal(fs.existsSync(path.join(leftover, "junk")), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/gateway-deploy-build.test.ts`
Expected: FAIL — `Cannot find module '../src/gateway/deploy/build'`

- [ ] **Step 3: Write the implementation**

`src/gateway/deploy/build.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && node --import tsx --test test/gateway-deploy-build.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/deploy/build.ts packages/cli/test/gateway-deploy-build.test.ts
git commit -m "feat(deploy): build a release from a git commit"
```

---

### Task 3: Activate a release, verify, roll back

**Files:**
- Create: `src/gateway/deploy/activate.ts`
- Test: `test/gateway-deploy-activate.test.ts`

**Interfaces:**
- Consumes (Task 1): `RELEASE_INFO_FILE`, `pointLink`, `readLink`, `releaseDir`
- Produces:
  - `READY_POLL_MAX = 60`
  - `interface ActivateDeps { restart(): Promise<string>; readReady(): { pid: number; phase: string } | undefined; sleep(ms: number): Promise<void>; serviceRunsCurrent(): boolean }`
  - `type ActivateOutcome = "activated" | "already-current" | "links-only" | "rolled-back" | "failed"`
  - `interface ActivateResult { outcome: ActivateOutcome; release: string; previous?: string; message: string }`
  - `activateRelease(a: { root: string; name: string }, d: ActivateDeps): Promise<ActivateResult>`
  - `rollbackRelease(root: string, d: ActivateDeps): Promise<ActivateResult>`

Background the implementer needs: under launchd, the existing restart only issues `launchctl kickstart -k` and returns immediately. `runtime.json` (`readReady`) is written by the gateway: `phase` is `"starting"` early and `"ready"` only once Slack is connected. So success means *a different pid than before, with phase ready*.

`serviceRunsCurrent()` is true when the installed LaunchAgent's entry point is `releases/current/...`. When false (before the one-time migration), restarting would relaunch the old working-tree build and look like success, so activation flips the links and stops there.

- [ ] **Step 1: Write the failing test**

`test/gateway-deploy-activate.test.ts`:

```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { useIsolatedHome } from "./helpers/isolated-home";
import { activateRelease, rollbackRelease, type ActivateDeps } from "../src/gateway/deploy/activate";
import { pointLink, readLink, releasesRoot, writeReleaseInfo } from "../src/gateway/deploy/paths";

const OLD = "0.44.0-2fa1497";
const NEW = "0.45.0-abcdef0";

function makeRelease(root: string, name: string): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  writeReleaseInfo(dir, { ref: "HEAD", sha: "a".repeat(40), version: "0", builtAt: "2026-09-21T00:00:00.000Z", nodeVersion: "v22" });
}

/**
 * Fake service. `readyAfterRestart[i]` says whether the i-th restart leads to
 * a ready process. Each restart gets a fresh pid.
 */
function fakeService(readyAfterRestart: boolean[], runsCurrent = true): { deps: ActivateDeps; restarts: () => number } {
  let restarts = 0;
  let pid = 100;
  let phase = "ready";
  const deps: ActivateDeps = {
    serviceRunsCurrent: () => runsCurrent,
    sleep: async () => {},
    restart: async () => {
      const ok = readyAfterRestart[restarts] ?? false;
      restarts += 1;
      pid += 1;
      phase = ok ? "ready" : "starting";
      return "restarted";
    },
    readReady: () => ({ pid, phase }),
  };
  return { deps, restarts: () => restarts };
}

describe("activateRelease", () => {
  const home = useIsolatedHome("pmk-deploy-activate-");
  const setup = (): string => {
    const root = releasesRoot(home.dir());
    makeRelease(root, OLD);
    makeRelease(root, NEW);
    return root;
  };

  it("flips current, records previous, restarts once", async () => {
    const root = setup();
    pointLink(root, "current", OLD);
    const svc = fakeService([true]);
    const r = await activateRelease({ root, name: NEW }, svc.deps);
    assert.equal(r.outcome, "activated");
    assert.equal(r.previous, OLD);
    assert.equal(readLink(root, "current"), NEW);
    assert.equal(readLink(root, "previous"), OLD);
    assert.equal(svc.restarts(), 1);
  });

  it("first-ever deploy: no previous link is created", async () => {
    const root = setup();
    const r = await activateRelease({ root, name: NEW }, fakeService([true]).deps);
    assert.equal(r.outcome, "activated");
    assert.equal(readLink(root, "previous"), undefined);
  });

  it("already current: nothing changes and nothing restarts", async () => {
    const root = setup();
    pointLink(root, "current", NEW);
    const svc = fakeService([true]);
    const r = await activateRelease({ root, name: NEW }, svc.deps);
    assert.equal(r.outcome, "already-current");
    assert.equal(svc.restarts(), 0);
  });

  it("refuses a release that was never built", async () => {
    const root = setup();
    await assert.rejects(activateRelease({ root, name: "0.46.0-1111111" }, fakeService([true]).deps), /is not built/);
    assert.equal(readLink(root, "current"), undefined);
  });

  it("not ready in time: restores both links and restarts again", async () => {
    const root = setup();
    makeRelease(root, "0.43.0-0000000");
    pointLink(root, "previous", "0.43.0-0000000");
    pointLink(root, "current", OLD);
    const svc = fakeService([false, true]);
    const r = await activateRelease({ root, name: NEW }, svc.deps);
    assert.equal(r.outcome, "rolled-back");
    assert.equal(readLink(root, "current"), OLD);
    assert.equal(readLink(root, "previous"), "0.43.0-0000000");
    assert.equal(svc.restarts(), 2);
  });

  it("rollback restart also fails: outcome failed, links still restored", async () => {
    const root = setup();
    pointLink(root, "current", OLD);
    const r = await activateRelease({ root, name: NEW }, fakeService([false, false]).deps);
    assert.equal(r.outcome, "failed");
    assert.equal(readLink(root, "current"), OLD);
    assert.match(r.message, /gateway\.err\.log/);
  });

  it("first-ever deploy that never becomes ready: failed, nothing to roll back to", async () => {
    const root = setup();
    const svc = fakeService([false]);
    const r = await activateRelease({ root, name: NEW }, svc.deps);
    assert.equal(r.outcome, "failed");
    assert.equal(svc.restarts(), 1);
  });

  it("LaunchAgent does not run releases/current: links flip, no restart", async () => {
    const root = setup();
    const svc = fakeService([true], false);
    const r = await activateRelease({ root, name: NEW }, svc.deps);
    assert.equal(r.outcome, "links-only");
    assert.equal(readLink(root, "current"), NEW);
    assert.equal(svc.restarts(), 0);
    assert.match(r.message, /install-service --force/);
  });

  it("a stale ready record from the old pid does not count as success", async () => {
    const root = setup();
    pointLink(root, "current", OLD);
    const deps: ActivateDeps = {
      serviceRunsCurrent: () => true, sleep: async () => {}, restart: async () => "restarted",
      readReady: () => ({ pid: 100, phase: "ready" }), // pid never changes
    };
    const r = await activateRelease({ root, name: NEW }, deps);
    assert.notEqual(r.outcome, "activated");
  });
});

describe("rollbackRelease", () => {
  const home = useIsolatedHome("pmk-deploy-rollback-");

  it("activates previous", async () => {
    const root = releasesRoot(home.dir());
    makeRelease(root, OLD);
    makeRelease(root, NEW);
    pointLink(root, "current", NEW);
    pointLink(root, "previous", OLD);
    const r = await rollbackRelease(root, fakeService([true]).deps);
    assert.equal(r.outcome, "activated");
    assert.equal(readLink(root, "current"), OLD);
    assert.equal(readLink(root, "previous"), NEW);
  });

  it("throws when there is no previous release", async () => {
    const root = releasesRoot(home.dir());
    fs.mkdirSync(root, { recursive: true });
    await assert.rejects(rollbackRelease(root, fakeService([true]).deps), /no previous release/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/gateway-deploy-activate.test.ts`
Expected: FAIL — `Cannot find module '../src/gateway/deploy/activate'`

- [ ] **Step 3: Write the implementation**

`src/gateway/deploy/activate.ts`:

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import { RELEASE_INFO_FILE, pointLink, readLink, releaseDir } from "./paths";

/** ~1 s per poll. A cold gateway start reaches "ready" in well under this. */
export const READY_POLL_MAX = 60;
const POLL_INTERVAL_MS = 1000;

export interface ActivateDeps {
  restart: () => Promise<string>;
  readReady: () => { pid: number; phase: string } | undefined;
  sleep: (ms: number) => Promise<void>;
  /** True when the installed LaunchAgent's entry point is releases/current. */
  serviceRunsCurrent: () => boolean;
}

export type ActivateOutcome = "activated" | "already-current" | "links-only" | "rolled-back" | "failed";

export interface ActivateResult {
  outcome: ActivateOutcome;
  release: string;
  previous?: string;
  message: string;
}

/**
 * Under launchd the restart is `kickstart -k`, which returns at once. Success
 * is a DIFFERENT pid reporting phase "ready": the old process's record is
 * still on disk right after the kick, and "starting" only means it booted.
 */
async function restartAndAwaitReady(d: ActivateDeps): Promise<boolean> {
  const before = d.readReady()?.pid;
  await d.restart();
  for (let i = 0; i < READY_POLL_MAX; i++) {
    await d.sleep(POLL_INTERVAL_MS);
    const r = d.readReady();
    if (r && r.pid !== before && r.phase === "ready") return true;
  }
  return false;
}

function restoreLinks(root: string, current: string, previous: string | undefined): void {
  pointLink(root, "current", current);
  if (previous) pointLink(root, "previous", previous);
}

export async function activateRelease(
  a: { root: string; name: string },
  d: ActivateDeps,
): Promise<ActivateResult> {
  if (!fs.existsSync(path.join(releaseDir(a.root, a.name), RELEASE_INFO_FILE))) {
    throw new Error(`release ${a.name} is not built`);
  }
  const oldCurrent = readLink(a.root, "current");
  const oldPrevious = readLink(a.root, "previous");
  if (oldCurrent === a.name) {
    return { outcome: "already-current", release: a.name, message: `${a.name} is already current; not restarted.` };
  }

  if (oldCurrent) pointLink(a.root, "previous", oldCurrent);
  pointLink(a.root, "current", a.name);

  if (!d.serviceRunsCurrent()) {
    return {
      outcome: "links-only",
      release: a.name,
      previous: oldCurrent,
      message:
        `current → ${a.name}. The LaunchAgent does not run releases/current, so the service was NOT restarted.\n` +
        `Migrate once: ${path.join(a.root, "current", "packages", "cli", "dist", "index.js")} gateway install-service --force, then restart.`,
    };
  }

  if (await restartAndAwaitReady(d)) {
    return { outcome: "activated", release: a.name, previous: oldCurrent, message: `activated ${a.name}.` };
  }
  if (!oldCurrent) {
    return {
      outcome: "failed",
      release: a.name,
      message: `${a.name} did not reach phase "ready" within ${READY_POLL_MAX}s and there is no previous release to roll back to — see ~/.pmk/logs/gateway.err.log`,
    };
  }

  restoreLinks(a.root, oldCurrent, oldPrevious);
  const recovered = await restartAndAwaitReady(d);
  return {
    outcome: recovered ? "rolled-back" : "failed",
    release: a.name,
    previous: oldCurrent,
    message: recovered
      ? `${a.name} did not reach phase "ready" within ${READY_POLL_MAX}s; rolled back to ${oldCurrent}.`
      : `${a.name} did not become ready, and the restart of ${oldCurrent} did not either — see ~/.pmk/logs/gateway.err.log`,
  };
}

export async function rollbackRelease(root: string, d: ActivateDeps): Promise<ActivateResult> {
  const previous = readLink(root, "previous");
  if (!previous) throw new Error("no previous release to roll back to");
  return activateRelease({ root, name: previous }, d);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && node --import tsx --test test/gateway-deploy-activate.test.ts`
Expected: PASS, 11 tests. (The stale-pid test loops 120 fake sleeps; it should still finish in milliseconds.)

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/deploy/activate.ts packages/cli/test/gateway-deploy-activate.test.ts
git commit -m "feat(deploy): activate a release with ready verification and rollback"
```

---

### Task 4: Retention

**Files:**
- Create: `src/gateway/deploy/prune.ts`
- Test: `test/gateway-deploy-prune.test.ts`

**Interfaces:**
- Consumes (Task 1): `listReleases`, `readLink`, `releaseDir`
- Produces: `DEFAULT_KEEP = 3`, `pruneReleases(root: string, keep?: number): string[]` — returns the removed names

- [ ] **Step 1: Write the failing test**

`test/gateway-deploy-prune.test.ts`:

```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { useIsolatedHome } from "./helpers/isolated-home";
import { pruneReleases } from "../src/gateway/deploy/prune";
import { listReleases, pointLink, releasesRoot, writeReleaseInfo } from "../src/gateway/deploy/paths";

function makeRelease(root: string, name: string, day: number): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const builtAt = `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  writeReleaseInfo(dir, { ref: "HEAD", sha: "a".repeat(40), version: "0", builtAt, nodeVersion: "v22" });
}

describe("pruneReleases", () => {
  const home = useIsolatedHome("pmk-deploy-prune-");
  const five = (): string => {
    const root = releasesRoot(home.dir());
    ["0.1.0-0000001", "0.2.0-0000002", "0.3.0-0000003", "0.4.0-0000004", "0.5.0-0000005"]
      .forEach((n, i) => makeRelease(root, n, i + 1));
    return root;
  };

  it("keeps 3: current, previous and the newest other; removes the oldest", () => {
    const root = five();
    pointLink(root, "current", "0.5.0-0000005");
    pointLink(root, "previous", "0.4.0-0000004");
    assert.deepEqual(pruneReleases(root), ["0.1.0-0000001", "0.2.0-0000002"]);
    assert.deepEqual(listReleases(root), ["0.3.0-0000003", "0.4.0-0000004", "0.5.0-0000005"]);
  });

  it("never removes current or previous even when they are the oldest", () => {
    const root = five();
    pointLink(root, "current", "0.1.0-0000001");
    pointLink(root, "previous", "0.2.0-0000002");
    pruneReleases(root);
    assert.deepEqual(listReleases(root), ["0.1.0-0000001", "0.2.0-0000002", "0.5.0-0000005"]);
  });

  it("does nothing at or under the limit", () => {
    const root = releasesRoot(home.dir());
    makeRelease(root, "0.1.0-0000001", 1);
    makeRelease(root, "0.2.0-0000002", 2);
    assert.deepEqual(pruneReleases(root), []);
  });

  it("with no links yet, keeps the newest 3", () => {
    const root = five();
    assert.deepEqual(pruneReleases(root), ["0.1.0-0000001", "0.2.0-0000002"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/gateway-deploy-prune.test.ts`
Expected: FAIL — `Cannot find module '../src/gateway/deploy/prune'`

- [ ] **Step 3: Write the implementation**

`src/gateway/deploy/prune.ts`:

```ts
import * as fs from "node:fs";
import { listReleases, readLink, releaseDir } from "./paths";

/** ~310 MB per release on the production machine; 3 ≈ 930 MB. */
export const DEFAULT_KEEP = 3;

/** Remove the oldest releases beyond `keep`. `current` and `previous` are never removed. */
export function pruneReleases(root: string, keep: number = DEFAULT_KEEP): string[] {
  const pinned = new Set(
    [readLink(root, "current"), readLink(root, "previous")].filter((n): n is string => n !== undefined),
  );
  const removable = listReleases(root).filter((n) => !pinned.has(n)); // oldest first
  const budget = Math.max(0, keep - pinned.size);
  const drop = removable.slice(0, Math.max(0, removable.length - budget));
  for (const name of drop) fs.rmSync(releaseDir(root, name), { recursive: true, force: true });
  return drop;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && node --import tsx --test test/gateway-deploy-prune.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/deploy/prune.ts packages/cli/test/gateway-deploy-prune.test.ts
git commit -m "feat(deploy): release retention"
```

---

### Task 5: Deploy events

**Files:**
- Modify: `src/gateway/events.ts` (add an interface after `GatewayPresenceEvent` ~line 117; extend the `GatewayEvent` union ~line 336; extend `EVENT_TYPE_TABLE` ~line 376)
- Test: `test/gateway-events.test.ts` (add one test inside the existing top-level `describe`)

**Interfaces:**
- Produces: `interface GatewayDeployEvent { type: "gateway.deployed" | "gateway.rollback"; release: string; sha: string; ref?: string; previous?: string; reason?: string }`, included in `GatewayEvent`

`EVENT_TYPE_TABLE` is typed `Record<GatewayEvent["type"], true>`: extending the union without adding both keys is a compile error, and the existing round-trip test iterates `GATEWAY_EVENT_TYPES`, so both new types are covered by it automatically.

- [ ] **Step 1: Write the failing test**

Add to `test/gateway-events.test.ts`, inside the outermost `describe`, reusing that file's existing HOME isolation:

```ts
  it("gateway.deployed and gateway.rollback are readable event types", async () => {
    const { GATEWAY_EVENT_TYPES } = await import("../src/gateway/events");
    assert.ok(GATEWAY_EVENT_TYPES.includes("gateway.deployed" as never));
    assert.ok(GATEWAY_EVENT_TYPES.includes("gateway.rollback" as never));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/gateway-events.test.ts`
Expected: FAIL on the new test (assertion `false == true`); all others pass.

- [ ] **Step 3: Write the implementation**

In `src/gateway/events.ts`, after the `GatewayPresenceEvent` interface:

```ts
/**
 * Which commit the service runs, and when that changed.
 *
 * Before releases existed the only way to tell was comparing `dist` mtime with
 * tag time. `gateway.deployed` is written after a release is activated and
 * confirmed ready; `gateway.rollback` when activation failed and the previous
 * release was restored (`reason` says why) or when the operator rolled back.
 */
export interface GatewayDeployEvent {
  type: "gateway.deployed" | "gateway.rollback";
  release: string;
  sha: string;
  ref?: string;
  previous?: string;
  reason?: string;
}
```

Add `| GatewayDeployEvent` to the `GatewayEvent` union directly after `| GatewayPresenceEvent`.

Add to `EVENT_TYPE_TABLE` directly after `"gateway.offline": true,`:

```ts
  "gateway.deployed": true,
  "gateway.rollback": true,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && node --import tsx --test test/gateway-events.test.ts`
Expected: PASS, including the existing "every declared event type survives a write→read round trip".

Then from the repo root: `npm run typecheck:test --workspace=packages/cli`
Expected: no errors. If a `switch` over `event.type` elsewhere reports a non-exhaustive case, add the two types to it with the same handling as `gateway.online`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/events.ts packages/cli/test/gateway-events.test.ts
git commit -m "feat(events): record gateway.deployed and gateway.rollback"
```

---

### Task 6: `deploy`, `activate`, `rollback` commands

**Files:**
- Create: `src/commands/gateway/deploy.ts`
- Modify: `src/commands/gateway/ops.ts` (split `restartCmd`, ~line 595)
- Modify: `src/commands/gateway/index.ts` (imports ~line 18, `switch` ~line 53, usage string ~line 62)
- Test: `test/gateway-deploy-cmd.test.ts`

**Interfaces:**
- Consumes: `buildRelease`, `BuildDeps`, `BuildResult` (Task 2); `activateRelease`, `rollbackRelease`, `ActivateDeps`, `ActivateResult` (Task 3); `pruneReleases` (Task 4); `GatewayDeployEvent` via `appendGatewayEvent` (Task 5); `releasesRoot`, `currentEntry`, `readLink`, `readReleaseInfo`, `releaseDir` (Task 1); `installedPlist`, `readGatewayRunStateRaw` from `src/gateway/run-state.ts`
- Produces:
  - in `ops.ts`: `restartGateway(): Promise<string>`
  - in `deploy.ts`: `parseDeployArgs(rest: string[]): { ref: string; repo?: string; activate: boolean }`, `interface DeployDeps { build: BuildDeps; activate: ActivateDeps; record(e: GatewayDeployEvent): void; print(line: string): void }`, `runDeploy(a: { ref: string; repo: string; root: string; activate: boolean }, d: DeployDeps): Promise<number>` (exit code), `plistRunsCurrent(plistXml: string | undefined, root: string): boolean`, `deployCmd(rest)`, `activateCmd(rest)`, `rollbackCmd()`

- [ ] **Step 1: Write the failing test**

`test/gateway-deploy-cmd.test.ts`:

```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { useIsolatedHome } from "./helpers/isolated-home";
import { parseDeployArgs, plistRunsCurrent, runDeploy, type DeployDeps } from "../src/commands/gateway/deploy";
import { currentEntry, listReleases, pointLink, readLink, releasesRoot, writeReleaseInfo } from "../src/gateway/deploy/paths";

const SHA = "abcdef0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function deps(o: { ready: boolean[]; buildFails?: boolean }): { d: DeployDeps; events: unknown[]; out: string[] } {
  const events: unknown[] = [];
  const out: string[] = [];
  let restarts = 0;
  let pid = 1;
  let phase = "ready";
  const d: DeployDeps = {
    record: (e) => { events.push(e); },
    print: (l) => { out.push(l); },
    build: {
      nodeVersion: "v22", nodePath: "/usr/bin/node", now: () => new Date("2026-09-21T00:00:00.000Z"),
      exportTree: (_r, _s, dest) => { fs.writeFileSync(path.join(dest, "package.json"), "{}"); },
      run: (file, args) => {
        if (o.buildFails && file === "npm") throw new Error("npm ci failed");
        if (args[0] === "rev-parse") return `${SHA}\n`;
        if (args[0] === "show") return JSON.stringify({ version: "0.45.0" });
        if (args.includes("--version")) return "0.45.0\n";
        return "";
      },
    },
    activate: {
      serviceRunsCurrent: () => true, sleep: async () => {},
      restart: async () => { phase = o.ready[restarts] ? "ready" : "starting"; restarts += 1; pid += 1; return "ok"; },
      readReady: () => ({ pid, phase }),
    },
  };
  return { d, events, out };
}

describe("parseDeployArgs", () => {
  it("takes a ref, optional --repo, and --no-activate", () => {
    assert.deepEqual(parseDeployArgs(["HEAD"]), { ref: "HEAD", repo: undefined, activate: true });
    assert.deepEqual(parseDeployArgs(["v0.45.0", "--repo", "/r", "--no-activate"]), { ref: "v0.45.0", repo: "/r", activate: false });
  });
  it("requires exactly one ref", () => {
    assert.throws(() => parseDeployArgs([]), /usage: pmk gateway deploy/);
    assert.throws(() => parseDeployArgs(["a", "b"]), /usage: pmk gateway deploy/);
    assert.throws(() => parseDeployArgs(["HEAD", "--repo"]), /usage: pmk gateway deploy/);
  });
});

describe("plistRunsCurrent", () => {
  it("is true only when the plist names releases/current's entry", () => {
    const root = "/Users/x/.pmk/releases";
    assert.equal(plistRunsCurrent(`<string>${currentEntry(root)}</string>`, root), true);
    assert.equal(plistRunsCurrent("<string>/Users/x/pm-workspace-kit/packages/cli/dist/index.js</string>", root), false);
    assert.equal(plistRunsCurrent(undefined, root), false);
  });
});

describe("runDeploy", () => {
  const home = useIsolatedHome("pmk-deploy-cmd-");
  const base = () => ({ ref: "HEAD", repo: "/repo", root: releasesRoot(home.dir()), activate: true });

  it("build + activate: exit 0, gateway.deployed recorded, old releases pruned", async () => {
    const root = base().root;
    for (const [n, day] of [["0.1.0-0000001", "01"], ["0.2.0-0000002", "02"], ["0.3.0-0000003", "03"]] as const) {
      fs.mkdirSync(path.join(root, n), { recursive: true });
      writeReleaseInfo(path.join(root, n), { ref: "x", sha: "b".repeat(40), version: "0", builtAt: `2026-09-${day}T00:00:00.000Z`, nodeVersion: "v22" });
    }
    pointLink(root, "current", "0.3.0-0000003");
    const { d, events } = deps({ ready: [true] });
    assert.equal(await runDeploy(base(), d), 0);
    assert.equal(readLink(root, "current"), "0.45.0-abcdef0");
    assert.deepEqual(events, [{ type: "gateway.deployed", release: "0.45.0-abcdef0", sha: SHA, ref: "HEAD", previous: "0.3.0-0000003" }]);
    assert.deepEqual(listReleases(root), ["0.2.0-0000002", "0.3.0-0000003", "0.45.0-abcdef0"]);
  });

  it("--no-activate: builds, leaves current alone, records nothing", async () => {
    const { d, events, out } = deps({ ready: [true] });
    assert.equal(await runDeploy({ ...base(), activate: false }, d), 0);
    assert.equal(readLink(base().root, "current"), undefined);
    assert.deepEqual(events, []);
    assert.ok(out.some((l) => /pmk gateway activate 0\.45\.0-abcdef0/.test(l)));
  });

  it("build failure: exit 1, current untouched, nothing recorded", async () => {
    const { d, events } = deps({ ready: [true], buildFails: true });
    assert.equal(await runDeploy(base(), d), 1);
    assert.equal(readLink(base().root, "current"), undefined);
    assert.deepEqual(events, []);
  });

  it("rolled back: exit 1 and gateway.rollback with the reason", async () => {
    const root = base().root;
    fs.mkdirSync(path.join(root, "0.3.0-0000003"), { recursive: true });
    writeReleaseInfo(path.join(root, "0.3.0-0000003"), { ref: "x", sha: "b".repeat(40), version: "0", builtAt: "2026-09-03T00:00:00.000Z", nodeVersion: "v22" });
    pointLink(root, "current", "0.3.0-0000003");
    const { d, events } = deps({ ready: [false, true] });
    assert.equal(await runDeploy(base(), d), 1);
    assert.equal(readLink(root, "current"), "0.3.0-0000003");
    assert.equal((events[0] as { type: string }).type, "gateway.rollback");
    assert.match((events[0] as { reason: string }).reason, /did not reach phase/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/gateway-deploy-cmd.test.ts`
Expected: FAIL — `Cannot find module '../src/commands/gateway/deploy'`

- [ ] **Step 3: Export `restartGateway` from ops.ts**

In `src/commands/gateway/ops.ts`, replace the whole `export async function restartCmd(): Promise<void> { ... }` with the two functions below. The body is unchanged apart from returning the message instead of printing it.

```ts
/** Restart through whichever supervisor is in use; returns the status line. */
export async function restartGateway(): Promise<string> {
  const logsDir = path.join(gatewayDir(), "..", "logs"); // ~/.pmk/logs
  fs.mkdirSync(logsDir, { recursive: true });

  const deps: RestartDeps = {
    ...realDeps,
    readReady: readGatewayRunStateRaw,
    spawnDetached: () => {
      const out = fs.openSync(path.join(logsDir, "gateway.out.log"), "a");
      const err = fs.openSync(path.join(logsDir, "gateway.err.log"), "a");
      const child = spawn(
        process.execPath,
        [path.resolve(__dirname, "../../index.js"), "gateway", "start"],
        { detached: true, stdio: ["ignore", out, err] },
      );
      child.unref();
      fs.closeSync(out);
      fs.closeSync(err);
      return child.pid ?? -1;
    },
  };
  return restartCmdImpl(deps);
}

export async function restartCmd(): Promise<void> {
  println(await restartGateway());
}
```

Run: `cd packages/cli && node --import tsx --test test/gateway-ops.test.ts`
Expected: PASS (behaviour unchanged).

- [ ] **Step 4: Write `src/commands/gateway/deploy.ts`**

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import chalk from "chalk";
import { println } from "../../io";
import { appendGatewayEvent, type GatewayDeployEvent } from "../../gateway/events";
import { installedPlist, readGatewayRunStateRaw } from "../../gateway/run-state";
import { buildRelease, type BuildDeps, type BuildResult } from "../../gateway/deploy/build";
import { activateRelease, rollbackRelease, type ActivateDeps, type ActivateResult } from "../../gateway/deploy/activate";
import { pruneReleases } from "../../gateway/deploy/prune";
import { currentEntry, readLink, readReleaseInfo, releaseDir, releasesRoot } from "../../gateway/deploy/paths";
import { restartGateway } from "./ops";

const USAGE = "usage: pmk gateway deploy <ref> [--repo <path>] [--no-activate]";
const MAX_TAR_BYTES = 512 * 1024 * 1024;
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

export interface DeployDeps {
  build: BuildDeps;
  activate: ActivateDeps;
  record: (e: GatewayDeployEvent) => void;
  print: (line: string) => void;
}

export function parseDeployArgs(rest: string[]): { ref: string; repo?: string; activate: boolean } {
  const positional: string[] = [];
  let repo: string | undefined;
  let activate = true;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--no-activate") activate = false;
    else if (a === "--repo") {
      repo = rest[++i];
      if (!repo) throw new Error(USAGE);
    } else positional.push(a);
  }
  if (positional.length !== 1) throw new Error(USAGE);
  return { ref: positional[0], repo, activate };
}

export function plistRunsCurrent(plistXml: string | undefined, root: string): boolean {
  return plistXml !== undefined && plistXml.includes(`<string>${currentEntry(root)}</string>`);
}

/**
 * Records the outcome and maps it to an exit code. `onSuccess` is
 * "gateway.rollback" when the operator asked for the previous release.
 */
function settle(
  r: ActivateResult,
  sha: string,
  ref: string | undefined,
  d: DeployDeps,
  onSuccess: GatewayDeployEvent["type"] = "gateway.deployed",
): number {
  d.print(r.message);
  if (r.outcome === "activated") {
    const reason = onSuccess === "gateway.rollback" ? "operator rollback" : undefined;
    d.record({ type: onSuccess, release: r.release, sha, ref, previous: r.previous, ...(reason ? { reason } : {}) });
    return 0;
  }
  if (r.outcome === "rolled-back" || r.outcome === "failed") {
    d.record({ type: "gateway.rollback", release: r.release, sha, ref, previous: r.previous, reason: r.message });
    return 1;
  }
  return 0; // already-current, links-only
}

export async function runDeploy(
  a: { ref: string; repo: string; root: string; activate: boolean },
  d: DeployDeps,
): Promise<number> {
  let built: BuildResult;
  try {
    built = buildRelease({ repo: a.repo, ref: a.ref, root: a.root }, d.build);
  } catch (e) {
    d.print(`build failed: ${(e as Error).message}`);
    d.print("current release was not changed.");
    return 1;
  }
  d.print(`${built.reused ? "reusing" : "built"} ${built.name} (${built.sha.slice(0, 7)})`);
  if (!a.activate) {
    d.print(`not activated. When ready: pmk gateway activate ${built.name}`);
    return 0;
  }
  const code = settle(await activateRelease({ root: a.root, name: built.name }, d.activate), built.sha, a.ref, d);
  if (code === 0) {
    for (const removed of pruneReleases(a.root)) d.print(`pruned ${removed}`);
  }
  return code;
}

function realDeps(root: string): DeployDeps {
  return {
    record: appendGatewayEvent,
    print: println,
    build: {
      nodeVersion: process.version,
      nodePath: process.execPath,
      now: () => new Date(),
      run: (file, args, cwd) =>
        execFileSync(file, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: MAX_STDOUT_BYTES }),
      exportTree: (repo, sha, dest) => {
        const tar = execFileSync("git", ["-C", repo, "archive", "--format=tar", sha], { maxBuffer: MAX_TAR_BYTES });
        execFileSync("tar", ["-x", "-C", dest], { input: tar });
      },
    },
    activate: {
      restart: restartGateway,
      readReady: readGatewayRunStateRaw,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      serviceRunsCurrent: () => {
        const plist = installedPlist();
        return plistRunsCurrent(plist ? fs.readFileSync(plist.plistPath, "utf8") : undefined, root);
      },
    },
  };
}

function repoToplevel(cwd: string): string {
  return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

export async function deployCmd(rest: string[]): Promise<void> {
  let args: ReturnType<typeof parseDeployArgs>;
  try {
    args = parseDeployArgs(rest);
  } catch (e) {
    println(chalk.yellow((e as Error).message));
    process.exit(1);
  }
  const root = releasesRoot();
  fs.mkdirSync(root, { recursive: true });
  const repo = path.resolve(args.repo ?? repoToplevel(process.cwd()));
  process.exitCode = await runDeploy({ ref: args.ref, repo, root, activate: args.activate }, realDeps(root));
}

async function activateNamed(name: string | undefined): Promise<void> {
  const root = releasesRoot();
  const d = realDeps(root);
  try {
    const r = name ? await activateRelease({ root, name }, d.activate) : await rollbackRelease(root, d.activate);
    const sha = readReleaseInfo(releaseDir(root, r.release))?.sha ?? "";
    process.exitCode = settle(r, sha, undefined, d, name ? "gateway.deployed" : "gateway.rollback");
  } catch (e) {
    println(chalk.red((e as Error).message));
    process.exitCode = 1;
  }
}

export async function activateCmd(rest: string[]): Promise<void> {
  if (rest.length !== 1) {
    println(chalk.yellow("usage: pmk gateway activate <release>"));
    process.exit(1);
  }
  await activateNamed(rest[0]);
}

export async function rollbackCmd(): Promise<void> {
  if (!readLink(releasesRoot(), "previous")) {
    println(chalk.red("no previous release to roll back to"));
    process.exitCode = 1;
    return;
  }
  await activateNamed(undefined);
}
```

- [ ] **Step 5: Route the subcommands**

In `src/commands/gateway/index.ts` add the import beside the `./service` import:

```ts
import { activateCmd, deployCmd, rollbackCmd } from "./deploy";
```

Add these cases directly before `case "install-service":`:

```ts
    case "deploy":
      return await deployCmd(rest);
    case "activate":
      return await activateCmd(rest);
    case "rollback":
      return await rollbackCmd();
```

Replace the usage string with:

```ts
          "usage: pmk gateway <init|start|stop|restart|status|stats|audience|escalation|atoms|admin|audit|doctor|demo|install-service|deploy|activate|rollback>",
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/cli && node --import tsx --test test/gateway-deploy-cmd.test.ts test/gateway-ops.test.ts`
Expected: PASS.

Then from the repo root: `npm run typecheck:test --workspace=packages/cli`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands/gateway/deploy.ts packages/cli/src/commands/gateway/ops.ts packages/cli/src/commands/gateway/index.ts packages/cli/test/gateway-deploy-cmd.test.ts
git commit -m "feat(gateway): deploy, activate and rollback commands"
```

---

### Task 7: `install-service` writes the `current` entry point

**Files:**
- Modify: `src/commands/gateway/service.ts` (new exported function; `installServiceCmd` ~line 96 where `distEntry` is computed)
- Modify: `src/gateway/deploy/paths.ts` (add `insideGitTree`)
- Test: `test/gateway-install-service.test.ts` (append a `describe`)

**Interfaces:**
- Consumes (Task 1): `releasesRoot`, `currentEntry`
- Produces: in `service.ts`: `resolveServiceEntry(o: { scriptDir: string; home: string; insideGitTree(dir: string): boolean }): { entry: string; warning?: string }`; in `deploy/paths.ts`: `insideGitTree(dir: string): boolean`

`scriptDir` is `__dirname` of the running `service.js`, i.e. `<something>/packages/cli/dist/commands/gateway`. Node resolves the main module to its real path, so when the installer is run through `releases/current/...` its `__dirname` is the *versioned* directory. Writing that into the plist would pin the service to one release, which is why it must be mapped back to `current`.

- [ ] **Step 1: Write the failing test**

Append to `test/gateway-install-service.test.ts` (add `resolveServiceEntry` to the existing import from `../src/commands/gateway/service`, and `import * as path from "node:path";` if not already present):

```ts
describe("install-service entry point", () => {
  const home = "/Users/x";
  const root = path.join(home, ".pmk", "releases");
  const never = () => false;

  it("run from a release: writes releases/current, not the versioned directory", () => {
    const scriptDir = path.join(root, "0.45.0-abcdef0", "packages", "cli", "dist", "commands", "gateway");
    const r = resolveServiceEntry({ scriptDir, home, insideGitTree: never });
    assert.equal(r.entry, path.join(root, "current", "packages", "cli", "dist", "index.js"));
    assert.equal(r.warning, undefined);
  });

  it("run from a git working tree: keeps the path and warns", () => {
    const scriptDir = "/Users/x/pm-workspace-kit/packages/cli/dist/commands/gateway";
    const r = resolveServiceEntry({ scriptDir, home, insideGitTree: () => true });
    assert.equal(r.entry, "/Users/x/pm-workspace-kit/packages/cli/dist/index.js");
    assert.match(r.warning ?? "", /working tree/);
    assert.match(r.warning ?? "", /pmk gateway deploy/);
  });

  it("run from anywhere else (global npm install): keeps the path, no warning", () => {
    const scriptDir = "/usr/local/lib/node_modules/@pmk/cli/dist/commands/gateway";
    const r = resolveServiceEntry({ scriptDir, home, insideGitTree: never });
    assert.equal(r.entry, "/usr/local/lib/node_modules/@pmk/cli/dist/index.js");
    assert.equal(r.warning, undefined);
  });

  it("a sibling directory that merely starts with the root's name is not a release", () => {
    const scriptDir = path.join(home, ".pmk", "releases-old", "x", "packages", "cli", "dist", "commands", "gateway");
    const r = resolveServiceEntry({ scriptDir, home, insideGitTree: never });
    assert.ok(r.entry.includes("releases-old"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/gateway-install-service.test.ts`
Expected: FAIL — `resolveServiceEntry` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/gateway/deploy/paths.ts` (it lives in the gateway layer because the doctor check in Task 8 needs it too, and `gateway/` must not import from `commands/gateway/`):

```ts
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
```

In `src/commands/gateway/service.ts` add the import:

```ts
import { currentEntry, insideGitTree, releasesRoot } from "../../gateway/deploy/paths";
```

Add after `envSecretWarnings`:

```ts
/**
 * Which entry point the LaunchAgent should run.
 *
 * Node resolves the main module to its real path, so an installer started via
 * `releases/current/...` sees the VERSIONED directory in `__dirname`. Writing
 * that into the plist would pin the service to one release and defeat the
 * `current` link, so a path under the releases root maps back to `current`.
 */
export function resolveServiceEntry(o: {
  scriptDir: string;
  home: string;
  insideGitTree: (dir: string) => boolean;
}): { entry: string; warning?: string } {
  const actual = path.resolve(o.scriptDir, "../../index.js");
  const root = releasesRoot(o.home);
  const rel = path.relative(root, actual);
  if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return { entry: currentEntry(root) };
  }
  if (o.insideGitTree(o.scriptDir)) {
    return {
      entry: actual,
      warning:
        `${actual} is inside a git working tree — any build there rewrites the running service. ` +
        "Deploy a release instead: pmk gateway deploy <ref>, then re-run install-service --force from releases/current.",
    };
  }
  return { entry: actual };
}
```

In `installServiceCmd`, replace:

```ts
  const distEntry = path.resolve(__dirname, "../../index.js");
```

with:

```ts
  const resolved = resolveServiceEntry({ scriptDir: __dirname, home: os.homedir(), insideGitTree });
  if (resolved.warning) println(`  ⚠️  ${resolved.warning}`);
  const distEntry = resolved.entry;
```

The existing `fs.existsSync(distEntry)` warning below it stays as is.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && node --import tsx --test test/gateway-install-service.test.ts`
Expected: PASS (existing tests plus 4 new).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/gateway/service.ts packages/cli/src/gateway/deploy/paths.ts packages/cli/test/gateway-install-service.test.ts
git commit -m "feat(install-service): point the LaunchAgent at releases/current"
```

---

### Task 8: Doctor check and status line

**Files:**
- Create: `src/gateway/doctor-checks/release-entry.ts`
- Modify: `src/gateway/doctor-checks/index.ts` (import, re-export, add to `DEFAULT_CHECKS` before `auditLogCheck`)
- Modify: `src/commands/gateway/ops.ts` (`buildStatusReport`, the `lines` array ~line 389)
- Test: `test/gateway-doctor-release-entry.test.ts`

**Interfaces:**
- Consumes: `currentEntry`, `readLink`, `readReleaseInfo`, `releaseDir`, `releasesRoot` (Task 1); `insideGitTree` from `deploy/paths.ts` (Task 7); `installedPlist` from `src/gateway/run-state.ts`; `DoctorCheckResult`, `DoctorContext` from `src/gateway/doctor.ts`
- Produces: `evaluateReleaseEntry(o: { plistXml: string | undefined; root: string; currentRelease: string | undefined; insideGitTree(dir: string): boolean }): DoctorCheckResult`, `releaseEntryCheck(ctx: DoctorContext): Promise<DoctorCheckResult>`, `releaseStatusLine(root: string): string`

- [ ] **Step 1: Write the failing test**

`test/gateway-doctor-release-entry.test.ts`:

```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { useIsolatedHome } from "./helpers/isolated-home";
import { evaluateReleaseEntry, releaseStatusLine } from "../src/gateway/doctor-checks/release-entry";
import { currentEntry, pointLink, releasesRoot, writeReleaseInfo } from "../src/gateway/deploy/paths";

const root = "/Users/x/.pmk/releases";
const plist = (entry: string) =>
  `<key>ProgramArguments</key><array>\n    <string>/usr/bin/node</string><string>${entry}</string><string>gateway</string><string>start</string>\n  </array>`;

describe("release-entry doctor check", () => {
  it("passes when the LaunchAgent runs releases/current", () => {
    const r = evaluateReleaseEntry({ plistXml: plist(currentEntry(root)), root, currentRelease: "0.45.0-abcdef0", insideGitTree: () => false });
    assert.equal(r.severity, "pass");
    assert.match(r.message, /0\.45\.0-abcdef0/);
  });

  it("fails when it runs releases/current but the link is missing", () => {
    const r = evaluateReleaseEntry({ plistXml: plist(currentEntry(root)), root, currentRelease: undefined, insideGitTree: () => false });
    assert.equal(r.severity, "fail");
    assert.match(r.hint ?? "", /pmk gateway deploy/);
  });

  it("warns when the entry point is inside a git working tree", () => {
    const r = evaluateReleaseEntry({
      plistXml: plist("/Users/x/pm-workspace-kit/packages/cli/dist/index.js"), root, currentRelease: undefined, insideGitTree: () => true,
    });
    assert.equal(r.severity, "warn");
    assert.match(r.message, /working tree/);
  });

  it("passes quietly with no LaunchAgent, or an entry point elsewhere", () => {
    assert.equal(evaluateReleaseEntry({ plistXml: undefined, root, currentRelease: undefined, insideGitTree: () => false }).severity, "pass");
    const other = evaluateReleaseEntry({ plistXml: plist("/opt/pmk/index.js"), root, currentRelease: undefined, insideGitTree: () => false });
    assert.equal(other.severity, "pass");
  });
});

describe("releaseStatusLine", () => {
  const home = useIsolatedHome("pmk-release-status-");

  it("shows the current release, its sha and ref", () => {
    const r = releasesRoot(home.dir());
    fs.mkdirSync(path.join(r, "0.45.0-abcdef0"), { recursive: true });
    writeReleaseInfo(path.join(r, "0.45.0-abcdef0"), { ref: "main", sha: "abcdef0" + "1".repeat(33), version: "0.45.0", builtAt: "2026-09-21T00:00:00.000Z", nodeVersion: "v22" });
    pointLink(r, "current", "0.45.0-abcdef0");
    assert.equal(releaseStatusLine(r), "  release:    0.45.0-abcdef0 (main, built 2026-09-21T00:00:00.000Z)");
  });

  it("says so when nothing is deployed", () => {
    assert.equal(releaseStatusLine(releasesRoot(home.dir())), "  release:    — (not deployed; see `pmk gateway deploy`)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/gateway-doctor-release-entry.test.ts`
Expected: FAIL — `Cannot find module '../src/gateway/doctor-checks/release-entry'`

- [ ] **Step 3: Write the implementation**

`src/gateway/doctor-checks/release-entry.ts`:

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import type { DoctorCheckResult, DoctorContext } from "../doctor";
import { installedPlist } from "../run-state";
import { currentEntry, insideGitTree, readLink, readReleaseInfo, releaseDir, releasesRoot } from "../deploy/paths";

const NAME = "release-entry";
const ENTRY_RE = /<key>ProgramArguments<\/key>\s*<array>\s*<string>[^<]*<\/string>\s*<string>([^<]*)<\/string>/;

/**
 * Is the service insulated from the repo? A LaunchAgent that runs a working
 * tree's `dist` is rewritten by any build there (`cli:build` begins with
 * `rm -rf dist`), and nothing else reports it.
 */
export function evaluateReleaseEntry(o: {
  plistXml: string | undefined;
  root: string;
  currentRelease: string | undefined;
  insideGitTree: (dir: string) => boolean;
}): DoctorCheckResult {
  const entry = o.plistXml === undefined ? undefined : ENTRY_RE.exec(o.plistXml)?.[1];
  if (!entry) return { name: NAME, severity: "pass", message: "no LaunchAgent installed" };

  if (entry === currentEntry(o.root)) {
    return o.currentRelease
      ? { name: NAME, severity: "pass", message: `LaunchAgent runs release ${o.currentRelease}` }
      : {
          name: NAME,
          severity: "fail",
          message: "LaunchAgent runs releases/current, but that link does not exist",
          hint: "deploy a release: pmk gateway deploy <ref>",
        };
  }
  if (o.insideGitTree(path.dirname(entry))) {
    return {
      name: NAME,
      severity: "warn",
      message: `LaunchAgent runs ${entry}, inside a git working tree — a build there rewrites the live service`,
      hint: "pmk gateway deploy <ref>, then run install-service --force from releases/current",
    };
  }
  return { name: NAME, severity: "pass", message: `LaunchAgent runs ${entry}` };
}

export async function releaseEntryCheck(ctx: DoctorContext): Promise<DoctorCheckResult> {
  const root = releasesRoot(ctx.home);
  const plist = installedPlist();
  return evaluateReleaseEntry({
    plistXml: plist ? fs.readFileSync(plist.plistPath, "utf8") : undefined,
    root,
    currentRelease: readLink(root, "current"),
    insideGitTree,
  });
}

/** One line for `pmk gateway status`. */
export function releaseStatusLine(root: string): string {
  const name = readLink(root, "current");
  if (!name) return "  release:    — (not deployed; see `pmk gateway deploy`)";
  const info = readReleaseInfo(releaseDir(root, name));
  return info ? `  release:    ${name} (${info.ref}, built ${info.builtAt})` : `  release:    ${name}`;
}
```

In `src/gateway/doctor-checks/index.ts`: add `import { releaseEntryCheck } from "./release-entry";`, add `releaseEntryCheck,` to the `export { ... }` block, and add it to `DEFAULT_CHECKS` directly before `auditLogCheck` with this comment:

```ts
  // Static, local: is the LaunchAgent insulated from repo builds?
  releaseEntryCheck,
```

In `src/commands/gateway/ops.ts`: add `import { releaseStatusLine } from "../../gateway/doctor-checks/release-entry";` and `import { releasesRoot } from "../../gateway/deploy/paths";`, then in `buildStatusReport` insert this element into `lines` directly after the `uptime` line:

```ts
    releaseStatusLine(releasesRoot()),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && node --import tsx --test test/gateway-doctor-release-entry.test.ts test/gateway-doctor.test.ts test/gateway-ops.test.ts`
Expected: PASS. If a test in `gateway-doctor.test.ts` asserts the exact number or order of `DEFAULT_CHECKS`, update it to include `release-entry` before `audit-log`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/doctor-checks/release-entry.ts packages/cli/src/gateway/doctor-checks/index.ts packages/cli/src/commands/gateway/ops.ts packages/cli/test/gateway-doctor-release-entry.test.ts
git commit -m "feat(doctor): report whether the LaunchAgent runs a release; show it in status"
```

---

### Task 9: Full suite, review, PR

**Files:** none new.

- [ ] **Step 1: Run the whole cli suite**

Run from the repo root: `npm test --workspace=packages/cli`
Expected: `fail 0`. The baseline on `main` at `2fa1497` is 1,188 passing tests in about 70 s; this branch adds roughly 45.

- [ ] **Step 2: Confirm production was not touched by the test run**

```bash
git status --short                     # only intended files
stat -f %Sm packages/cli/dist/index.js # still 2026-08-14 — nobody built in this checkout
launchctl print gui/$(id -u)/com.pmk.gateway | grep -E 'state|pid'
```

Expected: `dist` mtime unchanged, service `state = running`.

- [ ] **Step 3: Check file and function sizes**

```bash
wc -l packages/cli/src/gateway/deploy/*.ts packages/cli/src/commands/gateway/deploy.ts packages/cli/src/gateway/doctor-checks/release-entry.ts
```

Expected: every file under 200 lines. No function over 50 lines.

- [ ] **Step 4: Code review**

Use the code-reviewer agent on `git diff main...HEAD`. Fix CRITICAL and HIGH findings; fix MEDIUM where cheap. Re-run Step 1 after any change.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin feat/gateway-release-dir
gh pr create --title "feat(gateway): run the live service from a release directory" --body-file - <<'BODY'
## Why
The LaunchAgent runs this checkout's `packages/cli/dist`. `npm run cli:build` starts with `rm -rf dist`, so a build in the repo deletes the live service's code, and nothing records which commit is live.

## What
- `pmk gateway deploy <ref> [--no-activate]`: `git archive` → scoped `npm ci` → build → smoke test → `~/.pmk/releases/<version>-<sha7>/` → flip `current` → restart → wait for `phase: "ready"` → roll back on failure → prune to 3.
- `pmk gateway activate <release>`, `pmk gateway rollback`.
- `install-service` writes `releases/current/...` when run from a release; warns when run from a working tree.
- `doctor`: new `release-entry` check. `status`: shows the current release.
- Events: `gateway.deployed`, `gateway.rollback`.

Spec: `docs/superpowers/specs/2026-09-21-gateway-release-dir-design.md`

## Test plan
- [x] Unit tests for paths, build, activate/rollback, prune, command orchestration, install-service resolution, doctor check
- [x] Full cli suite green; `dist` mtime and the running service unchanged by the test run
- [ ] One-time migration on the production machine (plan Task 10)
- [ ] Live Slack verification after migration, before tagging

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
```

`gh` must be on the `hanfour` account for this repo: check with `gh auth status`, switch with `gh auth switch --user hanfour` if needed.

---

### Task 10: One-time migration on the production machine (with the operator)

This task changes the live service. **Do not run it unattended.** Each step is run with the operator watching; stop and ask at any unexpected output. It comes before merge because the project's rule is live verification before tagging.

**Preconditions:** Task 9 green; the branch is committed (deploy builds from a commit, so uncommitted changes are not included); no review is in flight (`pmk gateway status` shows low activity, or the operator says go).

- [ ] **Step 1: Record the starting state**

```bash
plutil -p ~/Library/LaunchAgents/com.pmk.gateway.plist | grep -A5 ProgramArguments
cp ~/Library/LaunchAgents/com.pmk.gateway.plist ~/Library/LaunchAgents/com.pmk.gateway.plist.pre-release-dir
launchctl print gui/$(id -u)/com.pmk.gateway | grep -E 'state|pid'
```

Expected: entry point `/Users/hanfourhuang/pm-workspace-kit/packages/cli/dist/index.js`, `state = running`.

- [ ] **Step 2: Build the first release from source, without a repo build**

From the **worktree** that has `feat/gateway-release-dir` checked out (`.claude/worktrees/gateway-release-dir`) — `--repo` defaults to the git toplevel of the current directory, and `HEAD` must be the branch head:

```bash
npx tsx packages/cli/src/index.ts gateway deploy HEAD
```

`tsx` runs the TypeScript directly, so the working tree's `dist` is never touched. Expected, after about two minutes:

```
built 0.44.0-<sha7> (<sha7>)
current → 0.44.0-<sha7>. The LaunchAgent does not run releases/current, so the service was NOT restarted.
Migrate once: /Users/hanfourhuang/.pmk/releases/current/packages/cli/dist/index.js gateway install-service --force, then restart.
```

Verify: `ls -la ~/.pmk/releases/` shows the release directory and `current -> 0.44.0-<sha7>`; `du -sh ~/.pmk/releases/0.44.0-*` is about 310 MB; the service is still running the old pid.

- [ ] **Step 3: Rewrite the plist from the release**

`install-service` writes `process.execPath` into `ProgramArguments[0]` and captures `PATH` from the invoking shell. The live plist runs nvm's Node 22; a shell where Volta's Node 24 comes first would silently move production to another Node version in the same step. Run it with the node the live plist already names:

```bash
NODE=$(plutil -extract ProgramArguments.0 raw ~/Library/LaunchAgents/com.pmk.gateway.plist.pre-release-dir)
echo "$NODE"   # expect /Users/hanfourhuang/.nvm/versions/node/v22.21.1/bin/node
"$NODE" ~/.pmk/releases/current/packages/cli/dist/index.js gateway install-service --force
diff <(plutil -p ~/Library/LaunchAgents/com.pmk.gateway.plist.pre-release-dir) <(plutil -p ~/Library/LaunchAgents/com.pmk.gateway.plist)
```

The diff must show `ProgramArguments[1]` changing to the `releases/current` path and, at most, `PATH`. Anything else: stop.

Expected: the entry point is now `/Users/hanfourhuang/.pmk/releases/current/packages/cli/dist/index.js`, with no `⚠️ … working tree` warning. `WorkingDirectory` is still `/Users/hanfourhuang/OneAD` and `PATH` still contains the nvm `bin` directory (the plist captures `PATH` from the invoking shell — run this from the usual terminal, not from a stripped environment).

**Between Step 3 and Step 4 do not run `deploy`, `activate`, `rollback` or `pmk gateway restart`.** The plist file now names `current`, but launchd still holds the old job definition: `kickstart -k` would relaunch the old working-tree build, it would report `ready`, and a deploy would record a false `gateway.deployed`.

- [ ] **Step 4: Reload the LaunchAgent**

`kickstart -k` restarts the *loaded* definition, which still names the old entry point, so the agent must be unloaded and loaded again:

```bash
launchctl bootout gui/$(id -u)/com.pmk.gateway
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pmk.gateway.plist
launchctl enable gui/$(id -u)/com.pmk.gateway
```

This interrupts the service for the length of a normal restart. If `bootstrap` fails with `Bootstrap failed: 5: Input/output error`, the old process is still draining (up to 20 s): wait until `launchctl print gui/$(id -u)/com.pmk.gateway` fails, then run `bootstrap` again.

- [ ] **Step 5: Verify the service runs the release**

```bash
sleep 20; cat ~/.pmk/gateway/runtime.json
ps -o command= -p "$(python3 -c "import json;print(json.load(open('$HOME/.pmk/gateway/runtime.json'))['pid'])")"
node ~/.pmk/releases/current/packages/cli/dist/index.js gateway status
node ~/.pmk/releases/current/packages/cli/dist/index.js gateway doctor
```

Expected: `"phase": "ready"`; the process command line names `.pmk/releases/current/...`; `status` shows `release: 0.44.0-<sha7>`; doctor's `release-entry` is `pass`, 0 fail overall.

**If it does not come up within 60 s:** restore and reload —

```bash
cp ~/Library/LaunchAgents/com.pmk.gateway.plist.pre-release-dir ~/Library/LaunchAgents/com.pmk.gateway.plist
launchctl bootout gui/$(id -u)/com.pmk.gateway; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pmk.gateway.plist
tail -50 ~/.pmk/logs/gateway.err.log
```

- [ ] **Step 6: Prove the insulation**

With the service confirmed on the release, run the command that used to be dangerous:

In the **main checkout** (`/Users/hanfourhuang/pm-workspace-kit`):

```bash
npm run cli:build
cat ~/.pmk/gateway/runtime.json   # same pid, still "ready"
```

Then exercise the full path once more with a real restart, which is the first end-to-end run of activate + ready-wait. `pmk` on PATH is an npm link into the main checkout's `dist`, which is on `main` and has no `deploy` command, so call the release's own CLI, from the **worktree**:

```bash
# zsh does not word-split a variable, so keep `node` and the path separate
CLI="$HOME/.pmk/releases/current/packages/cli/dist/index.js"
git commit --allow-empty -m "chore: exercise gateway deploy"
node "$CLI" gateway deploy HEAD
```

Expected: `built 0.44.0-<new sha7>`, `activated 0.44.0-<new sha7>.`, exit 0, and a `gateway.deployed` line in `~/.pmk/gateway/events-2026-09.log`. Then `node "$CLI" gateway rollback` → `activated 0.44.0-<first sha7>.` and a `gateway.rollback` line with `reason: "operator rollback"`. Drop the empty commit afterwards with `git reset --hard HEAD~1` **only if** it was not pushed.

- [ ] **Step 7: Live Slack verification**

In `#新頻道`: @-mention the bot with a question, and trigger one `:cr:` review on a small PR. Read the replies with `conversations.replies` on the thread (bot replies are always threaded). Both must complete normally.

- [ ] **Step 8: Merge and release**

Squash-merge the PR, then follow the usual release steps (`npm run version:bump`, changelog entry in `apps/docs/docs/changelog.md`, tag). From this release on, shipping to production is `node ~/.pmk/releases/current/packages/cli/dist/index.js gateway deploy v<version>` run inside the repo (consider an alias; the `pmk` on PATH still links into the repo's `dist`). Update `apps/docs/docs/gateway/onboarding.md` and `getting-started.md`, which still describe `cli:build` + `install-service` from the repo. Open a follow-up issue: have the gateway write the realpath of its entry point into `runtime.json` so activation can verify which code the new pid runs. Remove `~/Library/LaunchAgents/com.pmk.gateway.plist.pre-release-dir` once the tagged release has run for a day.
