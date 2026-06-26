import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { probeAudio } from "../src/gateway/audio/probe";

const fakeRun = (stdout: string) => async () => ({ stdout, stderr: "" });

describe("probeAudio", () => {
  it("parses duration from ffprobe JSON", async () => {
    const json = JSON.stringify({ format: { duration: "3723.5", size: "1048576" } });
    const r = await probeAudio("/tmp/x.ogg", { run: fakeRun(json) as never });
    assert.equal(Math.round(r.durationSec), 3724);
    assert.equal(r.sizeBytes, 1048576);
  });
  it("throws on unparseable output", async () => {
    await assert.rejects(() => probeAudio("/tmp/x.ogg", { run: fakeRun("not json") as never }));
  });
});
