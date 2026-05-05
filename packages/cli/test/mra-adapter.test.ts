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
  MAX_MRA_STDOUT_BYTES,
  mraDoctor,
  PKB_BASE_DOCS,
  PKB_DIR_RELATIVE,
  resolveMraRepo,
  runMraAskWithBinary,
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

/**
 * Fall-back behaviour when `cfg.mraWorkspace` is set but stale (#43
 * review-followup / v0.10.0). The doc-comment on mraDoctor promises:
 * "Explicit override wins, but only if it actually looks like an mra
 * workspace — otherwise we fall back to the cwd walk so a stale config
 * field doesn't silently break a host that has a valid workspace
 * ancestor." Earlier code returned ok:false instead of falling back;
 * these tests pin the documented behaviour.
 */
describe("mraDoctor stale-workspace fall-back", () => {
  let tmp: string;
  let binDir: string;
  let validWs: string;
  let stale: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-mra-fallback-"));
    binDir = path.join(tmp, "bin");
    fs.mkdirSync(binDir);
    // Fake mra binary so findMraBinary's `which` call returns something.
    fs.writeFileSync(path.join(binDir, "mra"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    validWs = path.join(tmp, "ws");
    fs.mkdirSync(path.join(validWs, ".collab"), { recursive: true });
    fs.writeFileSync(path.join(validWs, ".collab", "repos.json"), "[]");
    stale = path.join(tmp, "stale-no-marker");
    fs.mkdirSync(stale);
    delete process.env.PMK_SKIP_MRA_PROBE;
    process.env.PATH = `${binDir}:${ORIG.PATH ?? ""}`;
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (ORIG.PMK_SKIP_MRA_PROBE !== undefined)
      process.env.PMK_SKIP_MRA_PROBE = ORIG.PMK_SKIP_MRA_PROBE;
    else delete process.env.PMK_SKIP_MRA_PROBE;
    process.env.PATH = ORIG.PATH;
  });

  it("falls back to cwd walk when explicit workspace lacks the marker but cwd is inside a valid workspace", () => {
    const sub = path.join(validWs, "deep", "nested");
    fs.mkdirSync(sub, { recursive: true });
    const r = mraDoctor({ workspace: stale, cwd: sub });
    assert.equal(r.ok, true, `expected ok:true, got reason=${r.reason}`);
    assert.equal(r.workspace, validWs);
  });

  it("returns ok:false with a reason when stale workspace AND no cwd workspace ancestor", () => {
    const orphan = path.join(tmp, "orphan");
    fs.mkdirSync(orphan);
    const r = mraDoctor({ workspace: stale, cwd: orphan });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /no mra workspace|repos\.json/);
  });

  it("still honors explicit workspace when it is valid (regression check)", () => {
    const r = mraDoctor({ workspace: validWs, cwd: tmp });
    assert.equal(r.ok, true);
    assert.equal(r.workspace, path.resolve(validWs));
  });
});

/**
 * runMraAskWithBinary spawn-behaviour tests (#22 / v0.10).
 *
 * Strategy: ship a tiny POSIX shell wrapper that mimics the mra CLI
 * shape (`mra ask <repo> <question>`) but `eval`s the question
 * through `node -e`, letting each test express its own fake-mra
 * behaviour inline without scattering temp scripts.
 *
 *   wrapper invoked as:  ./mra ask <repo> <question>
 *   wrapper does:        node -e "<question>" -- <repo> <question>
 *
 * That way `runMraAskWithBinary` calls the real binary with the real
 * argv shape, but the subprocess we actually exercise is a node
 * one-liner under our control.
 */
const FAKE_MRA_WRAPPER = `#!/bin/sh
# argv: ask <repo> <question>
exec ${process.execPath} -e "$3" -- "$1" "$2" "$3"
`;
let wrapperDir: string;
let wrapperPath: string;

describe("runMraAskWithBinary spawn behaviour (#22)", () => {
  beforeEach(() => {
    wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-fake-mra-"));
    wrapperPath = path.join(wrapperDir, "mra");
    fs.writeFileSync(wrapperPath, FAKE_MRA_WRAPPER, { mode: 0o755 });
  });

  afterEach(() => {
    if (wrapperDir) fs.rmSync(wrapperDir, { recursive: true, force: true });
  });

  it("returns ok=true and concatenated stdout on a clean exit", async () => {
    const r = await runMraAskWithBinary(
      wrapperPath,
      {
        repo: "erp",
        question: `process.stdout.write("line one\\nline two\\nline three\\n");`,
        cwd: process.cwd(),
        timeoutMs: 5000,
      },
      { maxRetries: 0 },
    );
    assert.equal(r.ok, true, `unexpected fail: ${r.reason ?? ""}`);
    assert.match(r.stdout, /line one[\s\S]*line two[\s\S]*line three/);
    assert.equal(r.attempts, 1);
  });

  it("invokes onProgress for each non-empty line, stripping CR, skipping the trailing partial line", async () => {
    const lines: string[] = [];
    const r = await runMraAskWithBinary(
      wrapperPath,
      {
        repo: "erp",
        question: `process.stdout.write("[ask] PKB loaded\\r\\n[ask] querying...\\n[ask] done\\n[partial without newline");`,
        cwd: process.cwd(),
        timeoutMs: 5000,
      },
      { onProgress: (l) => lines.push(l), maxRetries: 0 },
    );
    assert.equal(r.ok, true, `unexpected fail: ${r.reason ?? ""}`);
    assert.deepEqual(lines, [
      "[ask] PKB loaded",
      "[ask] querying...",
      "[ask] done",
    ]);
    assert.match(r.stdout, /\[partial without newline$/);
  });

  it("captures stderr and surfaces a tail of it in the failure reason", async () => {
    const r = await runMraAskWithBinary(
      wrapperPath,
      {
        repo: "erp",
        question: `process.stderr.write("step ok\\nfatal: bad question\\n"); process.exit(2);`,
        cwd: process.cwd(),
        timeoutMs: 5000,
      },
      { maxRetries: 0 },
    );
    assert.equal(r.ok, false);
    assert.match(r.stderr, /fatal: bad question/);
    assert.match(r.reason ?? "", /code=2/);
    assert.match(r.reason ?? "", /fatal: bad question/);
  });

  it("times out via SIGTERM kill and reports a timeout reason (not a generic 'exited' reason)", async () => {
    const r = await runMraAskWithBinary(
      wrapperPath,
      {
        repo: "erp",
        // setInterval keeps the event loop alive — SIGTERM is the
        // only way out, mirroring how a wedged mra ask would behave.
        question: `setInterval(() => {}, 60000);`,
        cwd: process.cwd(),
        timeoutMs: 200,
      },
      { maxRetries: 0 },
    );
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /timed out after 200ms/);
  });

  it("onProgress callback errors do not tear down stdout reading", async () => {
    let firedCount = 0;
    const r = await runMraAskWithBinary(
      wrapperPath,
      {
        repo: "erp",
        question: `process.stdout.write("a\\nb\\nc\\n");`,
        cwd: process.cwd(),
        timeoutMs: 5000,
      },
      {
        onProgress: () => {
          firedCount += 1;
          throw new Error("sink down");
        },
        maxRetries: 0,
      },
    );
    assert.equal(r.ok, true, `unexpected fail: ${r.reason ?? ""}`);
    assert.equal(firedCount, 3, "all lines still produced despite throws");
    assert.match(r.stdout, /a\nb\nc\n/);
  });

  it("reports a non-ok result with the spawn-error message when the binary cannot start", async () => {
    const r = await runMraAskWithBinary(
      "/path/to/definitely-not-a-binary-here-xyzzy",
      {
        repo: "erp",
        question: "ignored",
        cwd: process.cwd(),
        timeoutMs: 5000,
      },
      { maxRetries: 0 },
    );
    assert.equal(r.ok, false);
    assert.ok(
      (r.reason ?? "").length > 0,
      "expected a non-empty reason when the binary fails to spawn",
    );
  });

  it("survives a synchronous spawn() throw and resolves to a non-ok result (TDZ regression)", async () => {
    // NUL byte in the path makes Node's spawn() throw synchronously
    // (rather than emitting an async 'error' event). Earlier versions
    // of this code referenced timeoutHandle from the catch block
    // before its declaration, throwing a TDZ ReferenceError instead
    // of resolving the promise. This test pins the order.
    const r = await runMraAskWithBinary(
      "/cant have-nul",
      {
        repo: "erp",
        question: "ignored",
        cwd: process.cwd(),
        timeoutMs: 5000,
      },
      { maxRetries: 0 },
    );
    assert.equal(r.ok, false);
    assert.ok(
      (r.reason ?? "").length > 0,
      "expected a non-empty reason from the synchronous spawn throw",
    );
  });

  it("retries once when the first attempt looks transient (empty stderr + non-zero exit)", async () => {
    // Stateful fake: first invocation exits 1 with no stderr (which
    // looksTransient classifies as worth retrying), second exits 0.
    const stateFile = path.join(wrapperDir, "attempts");
    fs.writeFileSync(stateFile, "0");
    const r = await runMraAskWithBinary(
      wrapperPath,
      {
        repo: "erp",
        question: `
          const fs = require("node:fs");
          const f = ${JSON.stringify(stateFile)};
          const n = parseInt(fs.readFileSync(f, "utf8"), 10) + 1;
          fs.writeFileSync(f, String(n));
          if (n === 1) process.exit(1);
          process.stdout.write("ok on attempt " + n + "\\n");
        `,
        cwd: process.cwd(),
        timeoutMs: 5000,
      },
      { maxRetries: 1 },
    );
    assert.equal(r.ok, true, `expected eventual success: ${r.reason ?? ""}`);
    assert.equal(r.attempts, 2);
    assert.match(r.stdout, /ok on attempt 2/);
  });

  it("SIGTERMs the child and reports stdout-cap reason when stdout exceeds MAX_MRA_STDOUT_BYTES", async () => {
    // Write 1 MiB at a time until past the cap, then keep the process
    // alive with setInterval so the SIGTERM-from-overflow path is the
    // only way out (mirrors the prod hazard: a wedged mra streaming
    // unbounded output). maxRetries:1 also confirms looksTransient
    // treats the overflow reason as non-transient (no retry happens).
    const r = await runMraAskWithBinary(
      wrapperPath,
      {
        repo: "erp",
        question: `
          const buf = "x".repeat(1024 * 1024);
          const target = ${MAX_MRA_STDOUT_BYTES} + 2 * 1024 * 1024;
          let written = 0;
          while (written < target) {
            process.stdout.write(buf);
            written += buf.length;
          }
          setInterval(() => {}, 60000);
        `,
        cwd: process.cwd(),
        timeoutMs: 10_000,
      },
      { maxRetries: 1 },
    );
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /stdout exceeded/);
    assert.match(r.reason ?? "", new RegExp(String(MAX_MRA_STDOUT_BYTES)));
    assert.equal(
      r.attempts,
      1,
      "overflow must not be classified as transient (no retry)",
    );
  });
});
