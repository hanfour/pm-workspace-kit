import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { prepareChunks } from "../src/gateway/audio/chunk";

function makeDeps(encodedSize: number, calls: string[][]) {
  return {
    run: (async (_bin: string, args: string[]) => { calls.push(args); return { stdout: "", stderr: "" }; }) as never,
    probe: (async () => ({ durationSec: 7200, sizeBytes: encodedSize })) as never,
    statSize: (_p: string) => encodedSize,
  };
}

describe("prepareChunks", () => {
  it("returns a single encoded file when under the request limit", async () => {
    const calls: string[][] = [];
    const out = await prepareChunks("/tmp/in.m4a", "/tmp/job", makeDeps(5 * 1024 * 1024, calls));
    assert.equal(out.length, 1);
    assert.match(out[0], /encoded\.ogg$/);
    // exactly one ffmpeg re-encode call, no segment muxer
    assert.equal(calls.filter((a) => a.includes("segment")).length, 0);
  });
  it("segments when the encoded file exceeds the request limit", async () => {
    const calls: string[][] = [];
    // 60MB encoded → must segment
    await prepareChunks("/tmp/in.wav", "/tmp/job", { ...makeDeps(60 * 1024 * 1024, calls), listChunks: (() => ["/tmp/job/chunk-000.ogg", "/tmp/job/chunk-001.ogg", "/tmp/job/chunk-002.ogg"]) as never });
    assert.equal(calls.filter((a) => a.includes("segment")).length, 1);
  });
  it("never passes the source filename to ffmpeg as an output path", async () => {
    const calls: string[][] = [];
    await prepareChunks("/tmp/-evil.m4a", "/tmp/job", makeDeps(1024, calls));
    // output path is the controlled template, not the (leading-dash) source name
    const reencode = calls[0];
    const outIdx = reencode.length - 1;
    assert.match(reencode[outIdx], /\/tmp\/job\/encoded\.ogg$/);
    assert.ok(reencode.includes("--"), "must insert -- before positional args");
  });
});
