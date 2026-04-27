import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildExploreArgv,
  findMraWorkspace,
  listMraWorkspaceReposWithPkb,
  loadPkbBase,
  mraDoctor,
  PKB_BASE_DOCS,
  PKB_DIR_RELATIVE,
  resolveMraRepo,
} from "../src/adapters/mra";

const ORIG = {
  PMK_SKIP_MRA_PROBE: process.env.PMK_SKIP_MRA_PROBE,
  PATH: process.env.PATH,
};

describe("buildExploreArgv", () => {
  it("emits the canonical mra explore flags", () => {
    assert.deepEqual(buildExploreArgv("erp/order"), [
      "erp/order",
      "--with-deps",
    ]);
  });
});

describe("findMraWorkspace", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-mra-ws-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the dir holding .collab/repos.json (primary marker)", () => {
    fs.mkdirSync(path.join(tmp, ".collab"));
    fs.writeFileSync(path.join(tmp, ".collab", "repos.json"), "{}");
    const nested = path.join(tmp, "a", "b");
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(findMraWorkspace(nested), tmp);
  });

  it("falls back to a bare .collab dir (mid-init state)", () => {
    fs.mkdirSync(path.join(tmp, ".collab"));
    assert.equal(findMraWorkspace(tmp), tmp);
  });

  it("falls back to .mra-config (legacy / future-compat marker)", () => {
    fs.writeFileSync(path.join(tmp, ".mra-config"), "{}");
    assert.equal(findMraWorkspace(tmp), tmp);
  });

  it("falls back to mra-workspace.json (alt convention)", () => {
    fs.writeFileSync(path.join(tmp, "mra-workspace.json"), "{}");
    assert.equal(findMraWorkspace(tmp), tmp);
  });

  it("returns undefined when no marker is found in any ancestor", () => {
    const start = path.join(tmp, "deep", "nested");
    fs.mkdirSync(start, { recursive: true });
    const result = findMraWorkspace(start);
    // tmp itself has no marker. Result must not be tmp; may be undefined
    // or an unrelated ancestor on the test machine.
    assert.notEqual(result, tmp);
  });
});

describe("resolveMraRepo", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-mra-repo-"));
    fs.mkdirSync(path.join(tmp, "erp", "order"), { recursive: true });
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("resolves a relative repo against the workspace", () => {
    assert.equal(
      resolveMraRepo(tmp, "erp/order"),
      path.join(tmp, "erp", "order"),
    );
  });

  it("returns undefined for a missing repo", () => {
    assert.equal(resolveMraRepo(tmp, "erp/missing"), undefined);
  });

  it("rejects a path that exists but isn't a directory", () => {
    fs.writeFileSync(path.join(tmp, "regular-file"), "x");
    assert.equal(resolveMraRepo(tmp, "regular-file"), undefined);
  });

  it("accepts an absolute path verbatim", () => {
    const abs = path.join(tmp, "erp", "order");
    assert.equal(resolveMraRepo(tmp, abs), abs);
  });
});

describe("loadPkbBase", () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-mra-pkb-"));
    fs.mkdirSync(path.join(repo, PKB_DIR_RELATIVE), { recursive: true });
  });

  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it("returns the four base docs when all are present", () => {
    for (const name of PKB_BASE_DOCS) {
      fs.writeFileSync(path.join(repo, PKB_DIR_RELATIVE, name), `# ${name}`);
    }
    const docs = loadPkbBase(repo);
    assert.equal(docs.length, 4);
    assert.deepEqual(docs.map((d) => d.name).sort(), [...PKB_BASE_DOCS].sort());
    for (const d of docs) {
      assert.ok(d.content.startsWith("# "));
      assert.ok(d.mtime > 0);
    }
  });

  it("loads from .mra/pkb/, not the older .collab/pkb/", () => {
    // Plant docs at the WRONG path (the v0.5 layout); loader must skip.
    const wrongDir = path.join(repo, ".collab", "pkb");
    fs.mkdirSync(wrongDir, { recursive: true });
    fs.writeFileSync(path.join(wrongDir, "sitemap.md"), "# old");
    // Plant a doc at the RIGHT path.
    fs.writeFileSync(
      path.join(repo, PKB_DIR_RELATIVE, "sitemap.md"),
      "# correct",
    );
    const docs = loadPkbBase(repo);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].content.trim(), "# correct");
  });

  it("skips missing docs without throwing", () => {
    fs.writeFileSync(
      path.join(repo, PKB_DIR_RELATIVE, "sitemap.md"),
      "# sitemap",
    );
    const docs = loadPkbBase(repo);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].name, "sitemap.md");
  });

  it("does NOT include identity.md (not produced by current mra)", () => {
    // Even if a stray identity.md exists, it isn't in PKB_BASE_DOCS so
    // it should be ignored.
    fs.writeFileSync(
      path.join(repo, PKB_DIR_RELATIVE, "identity.md"),
      "# stray",
    );
    const docs = loadPkbBase(repo);
    assert.equal(docs.length, 0);
  });

  it("returns empty when .mra/pkb does not exist", () => {
    fs.rmSync(path.join(repo, ".mra"), { recursive: true });
    assert.deepEqual(loadPkbBase(repo), []);
  });
});

describe("listMraWorkspaceReposWithPkb", () => {
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-mra-list-"));
    fs.mkdirSync(path.join(ws, ".collab"));
  });

  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("returns repos that exist on disk and have PKB", () => {
    fs.writeFileSync(
      path.join(ws, ".collab", "repos.json"),
      JSON.stringify({
        repos: [
          { name: "with-pkb" },
          { name: "no-pkb" },
          { name: "missing-dir" },
        ],
      }),
    );
    fs.mkdirSync(path.join(ws, "with-pkb", PKB_DIR_RELATIVE), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(ws, "with-pkb", PKB_DIR_RELATIVE, "sitemap.md"),
      "# m",
    );
    fs.mkdirSync(path.join(ws, "no-pkb"));
    // missing-dir: not on disk

    assert.deepEqual(listMraWorkspaceReposWithPkb(ws), ["with-pkb"]);
  });

  it("skips archived entries", () => {
    fs.writeFileSync(
      path.join(ws, ".collab", "repos.json"),
      JSON.stringify({
        repos: [{ name: "active" }, { name: "old", archived: true }],
      }),
    );
    for (const name of ["active", "old"]) {
      fs.mkdirSync(path.join(ws, name, PKB_DIR_RELATIVE), { recursive: true });
      fs.writeFileSync(
        path.join(ws, name, PKB_DIR_RELATIVE, "sitemap.md"),
        "# m",
      );
    }
    assert.deepEqual(listMraWorkspaceReposWithPkb(ws), ["active"]);
  });

  it("returns empty when repos.json is missing", () => {
    assert.deepEqual(listMraWorkspaceReposWithPkb(ws), []);
  });

  it("returns empty when repos.json is malformed", () => {
    fs.writeFileSync(path.join(ws, ".collab", "repos.json"), "{not json");
    assert.deepEqual(listMraWorkspaceReposWithPkb(ws), []);
  });
});

describe("mraDoctor", () => {
  beforeEach(() => {
    process.env.PMK_SKIP_MRA_PROBE = "1";
    process.env.PATH = "/nonexistent-dir";
  });

  afterEach(() => {
    if (ORIG.PMK_SKIP_MRA_PROBE !== undefined)
      process.env.PMK_SKIP_MRA_PROBE = ORIG.PMK_SKIP_MRA_PROBE;
    else delete process.env.PMK_SKIP_MRA_PROBE;
    process.env.PATH = ORIG.PATH;
  });

  it("reports binary-missing when mra is not on PATH and probe is disabled", () => {
    const r = mraDoctor();
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /not found on PATH/);
    assert.equal(r.binaryPath, undefined);
  });
});
