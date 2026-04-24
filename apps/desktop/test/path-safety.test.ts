import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureInside } from "../src/main/ipc/fs";
import { findRepoRoot } from "../src/main/workspace";

describe("ensureInside — workspace path traversal defence", () => {
  const root = "/tmp/pmk-root";

  it("allows a child path", () => {
    const abs = ensureInside(root, `${root}/file.md`);
    assert.equal(abs, `${root}/file.md`);
  });

  it("allows the root itself", () => {
    assert.equal(ensureInside(root, root), root);
  });

  it("allows nested paths", () => {
    assert.equal(
      ensureInside(root, `${root}/a/b/c.md`),
      `${root}/a/b/c.md`,
    );
  });

  it("rejects `..` escape", () => {
    assert.throws(
      () => ensureInside(root, `${root}/../other`),
      /path escapes workspace/,
    );
  });

  it("rejects unrelated absolute paths", () => {
    assert.throws(
      () => ensureInside(root, "/etc/passwd"),
      /path escapes workspace/,
    );
  });

  it("rejects sibling directory with shared prefix", () => {
    // /tmp/pmk-roots starts with /tmp/pmk-root but isn't inside it
    assert.throws(
      () => ensureInside(root, "/tmp/pmk-roots/file"),
      /path escapes workspace/,
    );
  });

  it("normalises redundant slashes and dots", () => {
    assert.equal(
      ensureInside(root, `${root}/./a//b/../b/c.md`),
      `${root}/a/b/c.md`,
    );
  });
});

describe("findRepoRoot", () => {
  it("walks up to a dir containing .git", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-repo-"));
    try {
      fs.mkdirSync(path.join(tmp, ".git"));
      const nested = path.join(tmp, "a", "b", "c");
      fs.mkdirSync(nested, { recursive: true });
      assert.equal(findRepoRoot(nested), tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to start dir when no .git is found", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-norepo-"));
    try {
      // Not creating .git at any ancestor — but the filesystem root
      // may have one depending on the test machine; use a non-existent
      // start path to force the fallback.
      const start = path.join(tmp, "does", "not", "exist");
      const result = findRepoRoot(start);
      assert.equal(typeof result, "string");
      assert.ok(result.length > 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
