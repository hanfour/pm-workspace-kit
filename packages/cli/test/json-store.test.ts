import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isRecord,
  readJsonFile,
  writeJsonFile,
} from "../src/gateway/json-store";

interface Foo {
  a: number;
}
const isFoo = (v: unknown): v is Foo =>
  isRecord(v) && typeof v.a === "number";

describe("json-store", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-jsonstore-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("write → read round-trips a valid document", () => {
    const file = path.join(tmp, "nested", "deep", "x.json");
    writeJsonFile(file, { a: 7 });
    // parent dirs were created
    assert.ok(fs.existsSync(file));
    assert.deepEqual(readJsonFile(file, isFoo), { a: 7 });
  });

  it("preserves the legacy on-disk format (2-space indent, no trailing newline)", () => {
    const file = path.join(tmp, "x.json");
    writeJsonFile(file, { a: 1 });
    assert.equal(fs.readFileSync(file, "utf8"), '{\n  "a": 1\n}');
  });

  it("missing file → undefined", () => {
    assert.equal(readJsonFile(path.join(tmp, "nope.json"), isFoo), undefined);
  });

  it("corrupt JSON → undefined (no throw)", () => {
    const file = path.join(tmp, "bad.json");
    fs.writeFileSync(file, "{ not json ");
    assert.equal(readJsonFile(file, isFoo), undefined);
  });

  it("valid JSON but wrong shape → undefined", () => {
    const file = path.join(tmp, "wrong.json");
    fs.writeFileSync(file, JSON.stringify({ a: "not-a-number" }));
    assert.equal(readJsonFile(file, isFoo), undefined);
  });

  it("writeJsonFile honours mode for secret files", () => {
    const file = path.join(tmp, "secret.json");
    writeJsonFile(file, { a: 1 }, { mode: 0o600 });
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
  });

  it("isRecord rejects arrays and null", () => {
    assert.equal(isRecord({}), true);
    assert.equal(isRecord([]), false);
    assert.equal(isRecord(null), false);
    assert.equal(isRecord("x"), false);
  });

  // These pin the DURABILITY property, not an implementation detail. A plain
  // writeFileSync truncates the existing inode in place, so a process killed
  // mid-write (SIGKILL, power loss, a launchd restart) leaves a half-written
  // document; readJsonFile then collapses it to undefined and the state is
  // silently gone. session.json, meta.json, escalation markers and run-state
  // all go through here. The approve-offer store already writes atomically
  // (writeOfferAtomic) — this brings the shared helper up to the same bar.
  describe("crash safety", () => {
    it("replaces the file rather than truncating it in place", () => {
      const file = path.join(tmp, "state.json");
      writeJsonFile(file, { a: 1 });
      // A reader that opened the old document keeps reading the OLD bytes:
      // an atomic write swaps in a new inode instead of rewriting this one.
      // Under truncate-in-place this fd would observe the new or partial doc.
      const held = fs.openSync(file, "r");
      try {
        writeJsonFile(file, { a: 2 });
        const buf = Buffer.alloc(64);
        const n = fs.readSync(held, buf, 0, 64, 0);
        assert.equal(
          JSON.parse(buf.subarray(0, n).toString()).a,
          1,
          "the previously-opened document must still read as complete old content",
        );
      } finally {
        fs.closeSync(held);
      }
      // and the new content did land
      assert.deepEqual(readJsonFile(file, isFoo), { a: 2 });
    });

    it("leaves no temp files behind", () => {
      const file = path.join(tmp, "state.json");
      writeJsonFile(file, { a: 1 });
      writeJsonFile(file, { a: 2 });
      assert.deepEqual(fs.readdirSync(tmp), ["state.json"]);
    });

    it("keeps the mode on replacement, not just on create", () => {
      const file = path.join(tmp, "secret.json");
      writeJsonFile(file, { a: 1 }, { mode: 0o600 });
      writeJsonFile(file, { a: 2 }, { mode: 0o600 });
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      }
    });
  });
});
