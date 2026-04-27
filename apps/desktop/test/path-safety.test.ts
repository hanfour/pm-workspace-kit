import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureInside, ensureInsideReal } from "../src/main/ipc/fs";
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
    assert.equal(ensureInside(root, `${root}/a/b/c.md`), `${root}/a/b/c.md`);
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

describe("ensureInsideReal — symlink-aware containment", () => {
  it("allows a non-symlink child", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-real-"));
    try {
      fs.writeFileSync(path.join(tmp, "file.md"), "x");
      const resolved = await ensureInsideReal(tmp, path.join(tmp, "file.md"));
      // macOS /var/folders is a symlink to /private/var/folders, so
      // compare against the realpath'd expectation rather than the
      // pre-realpath path.
      const expected = fs.realpathSync(path.join(tmp, "file.md"));
      assert.equal(resolved, expected);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects an in-workspace symlink pointing outside", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-realx-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-escape-"));
    try {
      const secret = path.join(outside, "secret.txt");
      fs.writeFileSync(secret, "bad");
      const link = path.join(tmp, "link.md");
      fs.symlinkSync(secret, link);
      await assert.rejects(
        ensureInsideReal(tmp, link),
        /escapes workspace via symlink/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("falls back to sync check for a not-yet-existing file (writeFile)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-realw-"));
    try {
      const nf = path.join(tmp, "new-file.md");
      const resolved = await ensureInsideReal(tmp, nf);
      assert.equal(resolved, nf);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("still rejects `..` escape before touching the filesystem", async () => {
    await assert.rejects(
      ensureInsideReal("/tmp/pmk-root", "/tmp/pmk-root/../outside"),
      /escapes workspace/,
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
