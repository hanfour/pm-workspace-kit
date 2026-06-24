import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  isSafeRepoPath,
  resolveRepoSlug,
  repoVisibility,
  createIssue,
  githubDoctor,
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
    assert.equal(isSafeRepoPath("."), false);
    assert.equal(isSafeRepoPath("a/./b"), false);
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

describe("repoVisibility", () => {
  it("maps gh output to public/private, errors to unknown", async () => {
    const ok = (v: string): GithubExec => async () => ({ stdout: v + "\n" });
    assert.equal(await repoVisibility({ slug: "o/r", token: "T" }, { exec: ok("PUBLIC") }), "public");
    assert.equal(await repoVisibility({ slug: "o/r", token: "T" }, { exec: ok("PRIVATE") }), "private");
    assert.equal(await repoVisibility({ slug: "o/r", token: "T" }, { exec: ok("INTERNAL") }), "private");
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
    assert.match(seenFile, /gh$/);
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

describe("githubDoctor", () => {
  it("not ok when token is empty", async () => {
    const r = await githubDoctor({ token: undefined }, { findBinary: () => "/usr/bin/gh" });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /token/i);
  });

  it("ok when gh present + token + auth succeeds", async () => {
    const r = await githubDoctor(
      { token: "T" },
      { findBinary: () => "/usr/bin/gh", exec: async () => ({ stdout: "ok" }) },
    );
    assert.equal(r.ok, true);
  });

  it("not ok when gh missing", async () => {
    const r = await githubDoctor({ token: "T" }, { findBinary: () => undefined });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /gh/i);
  });
});
