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
