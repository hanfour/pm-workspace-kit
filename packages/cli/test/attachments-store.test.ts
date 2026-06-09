import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendAttachment, loadAttachments, hasAttachment } from "../src/gateway/attachments/store";
import type { ThreadKey } from "../src/gateway/attachments/types";

const ORIG = process.env.HOME;
const KEY: ThreadKey = { kind: "dm", userId: "U1", threadTs: "1.2" };
const att = (id: string) => ({ fileId: id, name: "a.md", mimetype: "text/markdown", text: "hello", at: 1 });

describe("attachment store", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-store-")); process.env.HOME = tmp; });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (ORIG) process.env.HOME = ORIG; });

  it("append + load round-trips", () => {
    appendAttachment(KEY, att("F1"));
    appendAttachment(KEY, att("F2"));
    assert.deepEqual(loadAttachments(KEY).map((a) => a.fileId), ["F1", "F2"]);
  });
  it("is idempotent per fileId (second append is a no-op)", () => {
    appendAttachment(KEY, att("F1"));
    appendAttachment(KEY, att("F1"));
    assert.equal(loadAttachments(KEY).length, 1);
    assert.equal(hasAttachment(KEY, "F1"), true);
    assert.equal(hasAttachment(KEY, "F9"), false);
  });
  it("treats an empty-text entry as absent (re-extract)", () => {
    appendAttachment(KEY, { ...att("F1"), text: "" });
    assert.equal(hasAttachment(KEY, "F1"), false);
  });
  it("rejects an unsafe fileId", () => {
    assert.throws(() => appendAttachment(KEY, att("../x")), /unsafe/);
  });
});
