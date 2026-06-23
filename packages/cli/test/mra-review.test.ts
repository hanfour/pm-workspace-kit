import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveProjectByRemote, parseReviewStdout, buildReviewArgv } from "../src/adapters/mra";

let ws: string;
function mkRepo(dir: string, originUrl: string) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", originUrl], { cwd: dir });
}
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-ws-"));
  fs.mkdirSync(path.join(ws, ".collab"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".collab", "repos.json"),
    JSON.stringify({ repos: [{ name: "onepixel" }, { name: "billing" }] }),
  );
  mkRepo(path.join(ws, "onepixel"), "git@github.com:onead/OnePixel.git");
  mkRepo(path.join(ws, "billing"), "https://github.com/onead/billing");
});
afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

describe("review argv + stdout parse", () => {
  it("buildReviewArgv debate", () => {
    assert.deepEqual(buildReviewArgv("onepixel", 12, "debate"),
      ["review", "onepixel", "--pr", "12", "--strategy", "debate"]);
  });
  it("buildReviewArgv personas omits --strategy (env-driven)", () => {
    assert.deepEqual(buildReviewArgv("onepixel", 12, "personas"),
      ["review", "onepixel", "--pr", "12"]);
  });
  it("parseReviewStdout pulls status + comment count", () => {
    // EXACT sample lines from Task 0 spike — replace with real captured output:
    const out = "reviewing onepixel ...\nposting inline review to onead/OnePixel#12 (3 comments)...\nstatus: CHANGES_REQUESTED | comments: 3\n";
    assert.deepEqual(parseReviewStdout(out), { status: "CHANGES_REQUESTED", commentCount: 3 });
  });
});

describe("resolveProjectByRemote", () => {
  it("matches ssh remote (case-insensitive, .git stripped)", () => {
    assert.equal(resolveProjectByRemote(ws, "onead/OnePixel"), "onepixel");
    assert.equal(resolveProjectByRemote(ws, "onead/onepixel"), "onepixel");
  });
  it("matches https remote", () => {
    assert.equal(resolveProjectByRemote(ws, "onead/billing"), "billing");
  });
  it("returns undefined when no repo matches", () => {
    assert.equal(resolveProjectByRemote(ws, "onead/nope"), undefined);
  });
});
