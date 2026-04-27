import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildExploreArgv,
  findMraWorkspace,
  loadPkbBase,
  mraDoctor,
  resolveMraRepo,
  PKB_BASE_DOCS,
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

  it("returns the dir holding .mra-config", () => {
    fs.writeFileSync(path.join(tmp, ".mra-config"), "{}");
    const nested = path.join(tmp, "a", "b");
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(findMraWorkspace(nested), tmp);
  });

  it("returns the dir holding mra-workspace.json (alt convention)", () => {
    fs.writeFileSync(path.join(tmp, "mra-workspace.json"), "{}");
    assert.equal(findMraWorkspace(tmp), tmp);
  });

  it("returns undefined when no marker is found in any ancestor", () => {
    const start = path.join(tmp, "deep", "nested");
    fs.mkdirSync(start, { recursive: true });
    // tmp itself has no .mra-config; the system / has no expectation
    // here, but `/` won't have one either, so result is undefined.
    const result = findMraWorkspace(start);
    // Either undefined OR an unrelated ancestor on the test machine —
    // but it must not be `tmp` (we didn't create the marker there).
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
    fs.mkdirSync(path.join(repo, ".collab", "pkb"), { recursive: true });
  });

  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it("returns the four base docs when all are present", () => {
    for (const name of PKB_BASE_DOCS) {
      fs.writeFileSync(path.join(repo, ".collab", "pkb", name), `# ${name}`);
    }
    const docs = loadPkbBase(repo);
    assert.equal(docs.length, 4);
    assert.deepEqual(
      docs.map((d) => d.name).sort(),
      [...PKB_BASE_DOCS].sort(),
    );
    for (const d of docs) {
      assert.ok(d.content.startsWith("# "));
      assert.ok(d.mtime > 0);
    }
  });

  it("skips missing docs without throwing", () => {
    fs.writeFileSync(
      path.join(repo, ".collab", "pkb", "identity.md"),
      "# identity",
    );
    const docs = loadPkbBase(repo);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].name, "identity.md");
  });

  it("returns empty when .collab/pkb does not exist", () => {
    fs.rmSync(path.join(repo, ".collab"), { recursive: true });
    assert.deepEqual(loadPkbBase(repo), []);
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
