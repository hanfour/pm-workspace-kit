// packages/cli/test/review-workspace.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { prepareReviewClone, ensureReviewWorkspaceMeta, toHttpsGithub, pkbNeedsBuild } from "../src/gateway/review-workspace";

let root: string, mainWs: string, reviewWs: string, mainClone: string, origin: string, headSha: string;
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-rw-"));
  origin = path.join(root, "origin.git");
  mainWs = path.join(root, "ws");
  reviewWs = path.join(root, "review-ws");
  mainClone = path.join(mainWs, "proj");
  // bare origin with a main branch + a PR branch, exposed as refs/pull/1/head
  execFileSync("git", ["init", "-q", "--bare", origin]);
  const seed = path.join(root, "seed");
  execFileSync("git", ["clone", "-q", origin, seed]);
  fs.writeFileSync(path.join(seed, "a.txt"), "base\n");
  g(seed, "add", "-A"); g(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  g(seed, "branch", "-M", "main"); g(seed, "push", "-q", "origin", "main");
  g(seed, "checkout", "-qb", "feature");
  fs.writeFileSync(path.join(seed, "a.txt"), "changed\n");
  g(seed, "add", "-A"); g(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "feat");
  headSha = g(seed, "rev-parse", "HEAD");
  // expose as a PR head ref in the bare origin
  g(seed, "push", "-q", "origin", "HEAD:refs/pull/1/head");
  // main workspace clone with PKB + repos.json/dep-graph
  fs.mkdirSync(path.join(mainWs, ".collab"), { recursive: true });
  fs.writeFileSync(path.join(mainWs, ".collab", "repos.json"), JSON.stringify({ repos: [{ name: "proj" }] }));
  fs.writeFileSync(path.join(mainWs, ".collab", "dep-graph.json"), JSON.stringify({ projects: {} }));
  execFileSync("git", ["clone", "-q", origin, mainClone]);
  fs.mkdirSync(path.join(mainClone, ".mra", "pkb"), { recursive: true });
  fs.writeFileSync(path.join(mainClone, ".mra", "pkb", "meta.json"), JSON.stringify({ project: "proj" }));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("prepareReviewClone", () => {
  it("clones, fetches PR head, copies PKB, asserts head + non-empty diff", async () => {
    ensureReviewWorkspaceMeta(mainWs, reviewWs);
    assert.ok(fs.existsSync(path.join(reviewWs, ".collab", "dep-graph.json")));
    const res = await prepareReviewClone({
      mainClone, reviewWorkspace: reviewWs, project: "proj",
      slug: "o/r", pr: 1, expectedHeadSha: headSha, baseRef: "main",
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(g(res.cloneDir, "rev-parse", "HEAD"), headSha);
      assert.ok(fs.existsSync(path.join(res.cloneDir, ".mra", "pkb", "meta.json")));
      assert.ok(!fs.lstatSync(path.join(res.cloneDir, ".mra", "pkb")).isSymbolicLink());
    }
  });

  it("returns head-mismatch when expected SHA is wrong", async () => {
    ensureReviewWorkspaceMeta(mainWs, reviewWs);
    const res = await prepareReviewClone({
      mainClone, reviewWorkspace: reviewWs, project: "proj",
      slug: "o/r", pr: 1, expectedHeadSha: "0".repeat(40), baseRef: "main",
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /head-mismatch/);
  });

  it("resolves a NON-default base branch via origin/<base> (the FIN-dev case)", async () => {
    // Push a base branch that the fresh review clone will only have as
    // origin/<base> (not a local branch) — the empty-diff guard must resolve it.
    execFileSync("git", ["push", "-q", "origin", "main:FIN-dev"], { cwd: mainClone });
    ensureReviewWorkspaceMeta(mainWs, reviewWs);
    const res = await prepareReviewClone({
      mainClone, reviewWorkspace: reviewWs, project: "proj",
      slug: "o/r", pr: 1, expectedHeadSha: headSha, baseRef: "FIN-dev",
    });
    assert.equal(res.ok, true); // FIN-dev resolved via origin/FIN-dev; diff non-empty
  });

  it("toHttpsGithub normalises SSH github remotes to HTTPS, leaves others", () => {
    assert.equal(
      toHttpsGithub("git@github.com:onead/finance-system-ui.git"),
      "https://github.com/onead/finance-system-ui.git",
    );
    assert.equal(
      toHttpsGithub("git@github.com:onead/super-dsp-2.0"),
      "https://github.com/onead/super-dsp-2.0.git",
    );
    assert.equal(
      toHttpsGithub("ssh://git@github.com/onead/x.git"),
      "https://github.com/onead/x.git",
    );
    // HTTPS + local paths pass through unchanged
    assert.equal(
      toHttpsGithub("https://github.com/onead/billing.git"),
      "https://github.com/onead/billing.git",
    );
    assert.equal(toHttpsGithub("/tmp/some/origin.git"), "/tmp/some/origin.git");
  });

  it("still clones with a pinned ghToken (auth-env threading is non-breaking for non-github origins)", async () => {
    // The extraheader only targets https://github.com/; a local file origin is
    // unaffected, so passing a token must not break the clone. (Real github.com
    // auth via the token is verified out-of-band; this locks the threading.)
    ensureReviewWorkspaceMeta(mainWs, reviewWs);
    const res = await prepareReviewClone({
      mainClone, reviewWorkspace: reviewWs, project: "proj",
      slug: "o/r", pr: 1, expectedHeadSha: headSha, baseRef: "main",
      ghToken: "gho_faketoken_for_threading_test",
    });
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(g(res.cloneDir, "rev-parse", "HEAD"), headSha);
  });
});

describe("pkbNeedsBuild", () => {
  const pkbDir = () => path.join(mainClone, ".mra", "pkb");
  it("missing PKB → true", () => {
    fs.rmSync(path.join(mainClone, ".mra"), { recursive: true, force: true });
    assert.equal(pkbNeedsBuild(mainClone), true);
  });
  it("fresh + valid PKB → false", () => {
    for (const d of ["conventions", "architecture", "sitemap", "api-surface"]) {
      fs.writeFileSync(path.join(pkbDir(), `${d}.md`), "# Doc\n" + "real substantive content. ".repeat(6));
    }
    fs.writeFileSync(path.join(pkbDir(), "meta.json"), JSON.stringify({ project: "proj" })); // bump mtime to now
    assert.equal(pkbNeedsBuild(mainClone), false);
  });
  it("error-polluted core doc → true", () => {
    fs.writeFileSync(path.join(pkbDir(), "conventions.md"), "Error: Reached max turns (5)\n");
    assert.equal(pkbNeedsBuild(mainClone), true);
  });
  it("egregiously stale (PKB > 7 days old) → true", () => {
    fs.utimesSync(path.join(pkbDir(), "meta.json"), new Date("2020-01-01"), new Date("2020-01-01"));
    assert.equal(pkbNeedsBuild(mainClone), true);
  });
  it("mildly stale (recent PKB, newer commit) → false — nightly refresh handles drift, no per-review rebuild", () => {
    fs.writeFileSync(path.join(mainClone, "b.txt"), "x\n");
    g(mainClone, "add", "-A");
    g(mainClone, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "more");
    fs.writeFileSync(path.join(pkbDir(), "meta.json"), JSON.stringify({ project: "proj" })); // PKB just refreshed
    assert.equal(pkbNeedsBuild(mainClone), false);
  });
});
