import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { transcribeAudio } from "../src/gateway/audio/transcribe";
import { TranscribeError } from "../src/gateway/audio/transcribe-client";

const cfg = { apiKey: "sk-x", model: "m", language: "zh", maxDurationSec: 7200 };
const base = (over: Record<string, unknown> = {}) => ({
  probe: (async () => ({ durationSec: 1200, sizeBytes: 1024 })) as never,
  prepare: (async () => ["/tmp/job/chunk-000.ogg", "/tmp/job/chunk-001.ogg"]) as never,
  sleep: (async () => {}) as never,
  ...over,
});

describe("transcribeAudio", () => {
  it("rejects audio longer than the cap", async () => {
    const r = await transcribeAudio("/tmp/in.m4a", cfg, base({ probe: (async () => ({ durationSec: 9999, sizeBytes: 1 })) as never }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "too-long");
  });
  it("merges per-chunk transcripts", async () => {
    let n = 0;
    const r = await transcribeAudio("/tmp/in.m4a", cfg, base({ transcribeFile: (async () => `seg${n++}`) as never }));
    assert.equal(r.ok, true);
    if (r.ok) { assert.match(r.transcript, /seg0/); assert.match(r.transcript, /seg1/); assert.equal(r.chunks, 2); }
  });
  it("returns partial transcript + failedSegment when a chunk fails terminally (400)", async () => {
    let n = 0;
    const tf = async () => { if (n++ === 1) throw new TranscribeError("400", 400); return "ok-seg"; };
    const r = await transcribeAudio("/tmp/in.m4a", cfg, base({ transcribeFile: tf as never }));
    assert.equal(r.ok, false);
    if (!r.ok) { assert.equal(r.reason, "transcribe-failed"); assert.equal(r.failedSegment, 1); assert.match(r.partialTranscript ?? "", /ok-seg/); }
  });

  it("retries a transient 500 and succeeds on second attempt", async () => {
    let calls = 0;
    const tf = async () => { if (calls++ === 0) throw new TranscribeError("500", 500); return "seg"; };
    const r = await transcribeAudio("/tmp/in.m4a", cfg, base({
      prepare: (async () => ["/tmp/job/chunk-000.ogg"]) as never,
      transcribeFile: tf as never,
    }));
    assert.equal(r.ok, true);
    if (r.ok) assert.match(r.transcript, /seg/);
  });

  it("exhausts retries on persistent 500 → transcribe-failed", async () => {
    const tf = async () => { throw new TranscribeError("500", 500); };
    const r = await transcribeAudio("/tmp/in.m4a", cfg, base({
      prepare: (async () => ["/tmp/job/chunk-000.ogg"]) as never,
      transcribeFile: tf as never,
    }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "transcribe-failed");
  });
});
