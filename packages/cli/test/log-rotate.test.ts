import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The gateway's stdout/stderr are opened by launchd (StandardOutPath /
 * StandardErrorPath) and never rotated. One socket-churn episode wrote
 * 1,204,328 rate-limit warnings into gateway.err.log — 151 MB, 96.7% of it a
 * single repeated line. Nothing trims it, so the file only ever grows, and at
 * that size it is also impractical to investigate.
 *
 * Rotation must COPY-then-TRUNCATE, never rename: launchd holds the fd, so a
 * renamed file keeps receiving writes and the live path stays empty forever.
 * Truncating under the held descriptor is safe because launchd opens with
 * O_APPEND — each write seeks to the current end, so writes resume at 0
 * (verified empirically before this was written).
 */
describe("rotateLogIfLarge", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-logrot-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, bytes: number) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, "x".repeat(bytes));
    return p;
  };

  it("leaves a file under the threshold alone", async () => {
    const { rotateLogIfLarge } = await import("../src/gateway/log-rotate");
    const p = write("a.log", 100);
    const res = rotateLogIfLarge(p, { maxBytes: 1000, keep: 2 });
    assert.equal(res.rotated, false);
    assert.equal(fs.readdirSync(dir).length, 1);
    assert.equal(fs.statSync(p).size, 100);
  });

  it("is a no-op for a missing file", async () => {
    const { rotateLogIfLarge } = await import("../src/gateway/log-rotate");
    const res = rotateLogIfLarge(path.join(dir, "nope.log"), { maxBytes: 1, keep: 2 });
    assert.equal(res.rotated, false);
  });

  it("archives the content and empties the live file IN PLACE", async () => {
    const { rotateLogIfLarge } = await import("../src/gateway/log-rotate");
    const p = write("a.log", 5000);
    const inodeBefore = fs.statSync(p).ino;

    const res = rotateLogIfLarge(p, { maxBytes: 1000, keep: 2 });

    assert.equal(res.rotated, true);
    assert.equal(res.bytesArchived, 5000);
    assert.equal(fs.statSync(p).size, 0, "live file must be emptied");
    assert.equal(
      fs.statSync(p).ino,
      inodeBefore,
      "the live path must keep its inode — launchd's fd points at it",
    );
    assert.equal(fs.statSync(`${p}.1`).size, 5000, "content must survive in .1");
  });

  // The holder keeps writing through the rotation; nothing may be redirected
  // away from the path launchd opened.
  it("a writer holding the descriptor keeps landing in the live file", async () => {
    const { rotateLogIfLarge } = await import("../src/gateway/log-rotate");
    const p = path.join(dir, "a.log");
    const fd = fs.openSync(p, "a");
    try {
      fs.writeSync(fd, "o".repeat(5000));
      rotateLogIfLarge(p, { maxBytes: 1000, keep: 2 });
      fs.writeSync(fd, "new");
      assert.equal(fs.readFileSync(p, "utf8"), "new", "post-rotation writes land at offset 0");
    } finally {
      fs.closeSync(fd);
    }
  });

  it("shifts generations and drops the oldest beyond keep", async () => {
    const { rotateLogIfLarge } = await import("../src/gateway/log-rotate");
    const p = path.join(dir, "a.log");
    for (const gen of ["first", "second", "third"]) {
      fs.writeFileSync(p, gen.repeat(500));
      rotateLogIfLarge(p, { maxBytes: 100, keep: 2 });
    }
    assert.ok(fs.readFileSync(`${p}.1`, "utf8").startsWith("third"));
    assert.ok(fs.readFileSync(`${p}.2`, "utf8").startsWith("second"));
    assert.equal(fs.existsSync(`${p}.3`), false, "keep=2 must not retain a third archive");
  });

  it("never throws — a log that cannot be rotated must not stop the gateway", async () => {
    const { rotateLogIfLarge } = await import("../src/gateway/log-rotate");
    const p = write("a.log", 5000);
    fs.chmodSync(dir, 0o500); // archive cannot be created
    try {
      const res = rotateLogIfLarge(p, { maxBytes: 1000, keep: 2 });
      assert.equal(res.rotated, false);
      assert.ok(res.error, "the reason must be reported, not swallowed");
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });
});
