import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { attachmentLogPath } from "../src/gateway/session-store";

const ORIG = process.env.HOME;
describe("attachmentLogPath", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-alp-")); process.env.HOME = tmp; });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (ORIG) process.env.HOME = ORIG; });

  it("builds per-thread paths for dm and channel", () => {
    assert.equal(
      attachmentLogPath("dm", "U1", "111.222"),
      path.join(tmp, ".pmk", "gateway", "slack", "users", "U1", "threads", "111.222", "attachments.jsonl"),
    );
    assert.equal(
      attachmentLogPath("channel", "C1", "111.222"),
      path.join(tmp, ".pmk", "gateway", "slack", "channels", "C1", "threads", "111.222", "attachments.jsonl"),
    );
  });
  it("rejects unsafe segments", () => {
    assert.throws(() => attachmentLogPath("dm", "../evil", "1"), /unsafe/);
    assert.throws(() => attachmentLogPath("channel", "C1", ".."), /unsafe/);
  });
});
