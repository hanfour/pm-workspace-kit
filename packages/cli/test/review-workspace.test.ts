// packages/cli/test/review-workspace.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { prepareReviewClone, ensureReviewWorkspaceMeta } from "../src/gateway/review-workspace";

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
});
