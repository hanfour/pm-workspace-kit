import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { streamSlackFileToTemp } from "../src/gateway/audio/download-stream";
import type { SlackFile } from "../src/gateway/attachments/types";

const f = (over: Partial<SlackFile> = {}): SlackFile => ({ id: "F1", mimetype: "audio/mp4", size: 10, url_private_download: "https://files.slack.com/a.m4a", ...over });
const resp = (body: string) => new Response(body, { status: 200 });

describe("streamSlackFileToTemp", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-dl-")); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it("writes the body and returns byte count", async () => {
    const dest = path.join(tmp, "in.m4a");
    const r = await streamSlackFileToTemp(f(), "t", dest, { fetchImpl: (async () => resp("HELLO")) as never });
    assert.equal(r.bytes, 5);
    assert.equal(fs.readFileSync(dest, "utf8"), "HELLO");
  });
  it("rejects a non-slack host before fetching", async () => {
    let fetched = false;
    await assert.rejects(() => streamSlackFileToTemp(f({ url_private_download: "https://evil.com/x" }), "t", path.join(tmp, "x"),
      { fetchImpl: (async () => { fetched = true; return resp(""); }) as never }));
    assert.equal(fetched, false);
  });
  it("aborts + deletes when the stream exceeds maxBytes", async () => {
    const dest = path.join(tmp, "big");
    await assert.rejects(() => streamSlackFileToTemp(f({ size: 1 }), "t", dest, { fetchImpl: (async () => resp("X".repeat(100))) as never, maxBytes: 10 }));
    assert.equal(fs.existsSync(dest), false);
  });
  it("rejects before fetching when file.size exceeds maxBytes (metadata pre-check)", async () => {
    let fetched = false;
    await assert.rejects(
      () => streamSlackFileToTemp(
        f({ size: 500 }),
        "t",
        path.join(tmp, "precheck"),
        { fetchImpl: (async () => { fetched = true; return resp(""); }) as never, maxBytes: 100 },
      ),
      /exceeds size limit/,
    );
    assert.equal(fetched, false, "fetch must not be called when file.size already exceeds maxBytes");
  });
});
