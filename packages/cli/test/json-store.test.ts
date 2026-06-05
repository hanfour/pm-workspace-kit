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
});
