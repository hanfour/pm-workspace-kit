import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { fetchSlackFile, isAllowedSlackHost } from "../src/gateway/attachments/download";
import type { SlackFile } from "../src/gateway/attachments/types";

const file = (over: Partial<SlackFile> = {}): SlackFile => ({
  id: "F1",
  url_private_download: "https://files.slack.com/x/secret.pdf",
  size: 100,
  ...over,
});

function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < chunks.length) c.enqueue(chunks[i++]);
      else c.close();
    },
  });
}

describe("isAllowedSlackHost", () => {
  it("accepts slack hosts, rejects look-alikes", () => {
    assert.equal(isAllowedSlackHost("files.slack.com"), true);
    assert.equal(isAllowedSlackHost("foo.slack.com"), true);
    assert.equal(isAllowedSlackHost("files.slack.com.evil.com"), false);
    assert.equal(isAllowedSlackHost("evilslack.com"), false);
    assert.equal(isAllowedSlackHost("169.254.169.254"), false);
  });
});

describe("fetchSlackFile", () => {
  it("downloads bytes and sends the bot token as Bearer", async () => {
    let seenAuth = "";
    const fetchImpl = async (_url: string, init: any) => {
      seenAuth = init.headers.Authorization;
      return { ok: true, status: 200, body: streamFrom([new Uint8Array([1, 2, 3])]) } as any;
    };
    const buf = await fetchSlackFile(file(), "xoxb-TOKEN", { fetchImpl });
    assert.deepEqual([...buf], [1, 2, 3]);
    assert.equal(seenAuth, "Bearer xoxb-TOKEN");
  });

  it("rejects a non-slack host WITHOUT fetching", async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return {} as any; };
    await assert.rejects(
      () => fetchSlackFile(file({ url_private_download: "http://169.254.169.254/" }), "t", { fetchImpl }),
      /unexpected file host/,
    );
    assert.equal(called, false);
  });

  it("aborts when the stream exceeds MAX_FILE_BYTES even if metadata lies", async () => {
    const big = new Uint8Array(11 * 1024 * 1024);
    const fetchImpl = async () => ({ ok: true, status: 200, body: streamFrom([big]) } as any);
    await assert.rejects(
      () => fetchSlackFile(file({ size: 1 }), "t", { fetchImpl }),
      /exceeds size limit/,
    );
  });

  it("maps 403 to a scope error and never leaks the URL", async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, body: null } as any);
    await assert.rejects(
      () => fetchSlackFile(file(), "t", { fetchImpl }),
      (e: Error) => e.message.includes("files:read") && !e.message.includes("secret.pdf"),
    );
  });
});
