import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveProjectByRemote, parseReviewStdout, buildReviewArgv, reviewEnv } from "../src/adapters/mra";

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
  it("buildReviewArgv standard passes --strategy standard", () => {
    assert.deepEqual(buildReviewArgv("superdsp-ui", 547, "standard"),
      ["review", "superdsp-ui", "--pr", "547", "--strategy", "standard"]);
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
  it("falls back to a workspace dir-scan for a repo NOT in repos.json", () => {
    // `stray` is cloned in the workspace with a matching origin but is absent
    // from repos.json — it must still resolve via the dir-scan fallback
    // (returns the dir basename). Live-found gap, 2026-06-23.
    mkRepo(path.join(ws, "stray"), "https://github.com/onead/super-dsp-2.0.git");
    assert.equal(resolveProjectByRemote(ws, "onead/super-dsp-2.0"), "stray");
  });
  it("matches https remote", () => {
    assert.equal(resolveProjectByRemote(ws, "onead/billing"), "billing");
  });
  it("returns undefined when no repo matches", () => {
    assert.equal(resolveProjectByRemote(ws, "onead/nope"), undefined);
  });
});

describe("reviewEnv", () => {
  it("caps round-1 agent max-turns by default (rescues PKB-less / big PRs from a mid-exploration cutoff)", () => {
    const prev = process.env.MRA_REVIEW_AGENT_MAX_TURNS;
    delete process.env.MRA_REVIEW_AGENT_MAX_TURNS;
    try {
      assert.equal(reviewEnv("debate").MRA_REVIEW_AGENT_MAX_TURNS, "40");
    } finally {
      if (prev !== undefined) process.env.MRA_REVIEW_AGENT_MAX_TURNS = prev;
    }
  });
  it("respects an operator-set MRA_REVIEW_AGENT_MAX_TURNS", () => {
    const prev = process.env.MRA_REVIEW_AGENT_MAX_TURNS;
    process.env.MRA_REVIEW_AGENT_MAX_TURNS = "12";
    try {
      assert.equal(reviewEnv("debate").MRA_REVIEW_AGENT_MAX_TURNS, "12");
    } finally {
      if (prev === undefined) delete process.env.MRA_REVIEW_AGENT_MAX_TURNS;
      else process.env.MRA_REVIEW_AGENT_MAX_TURNS = prev;
    }
  });
  it("strips secrets, pins GH_TOKEN, sets the personas flag", () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test";
    try {
      const env = reviewEnv("personas", "ghtok");
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
      assert.equal(env.MRA_REVIEW_PERSONAS, "true");
      assert.equal(env.GH_TOKEN, "ghtok");
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
