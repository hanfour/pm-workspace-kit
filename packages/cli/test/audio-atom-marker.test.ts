import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeAtomMarker, readAtomMarker, acquireAtomMarker, deleteAtomMarker, sweepStaleAtomMarkers, type AtomMarker } from "../src/gateway/audio/atom-marker";

const ORIG = process.env.HOME;
const mk = (over: Partial<AtomMarker> = {}): AtomMarker => ({
  threadKey: "C1:1.1", channelId: "C1", summaryTs: "9.9", uploaderId: "U1",
  scope: "general", title: "t", tags: ["a"], summaryText: "s", at: 1000, ...over,
});

describe("atom-marker", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-am-")); process.env.HOME = tmp; });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (ORIG) process.env.HOME = ORIG; });

  it("write/read round-trips", () => {
    writeAtomMarker(mk());
    assert.equal(readAtomMarker("C1", "9.9")?.uploaderId, "U1");
  });
  it("acquire is a mutex: second acquire returns undefined", () => {
    writeAtomMarker(mk());
    assert.ok(acquireAtomMarker("C1", "9.9"), "first acquires");
    assert.equal(acquireAtomMarker("C1", "9.9"), undefined, "second is blocked");
  });
  it("writing a new marker drops a prior marker with the same threadKey (retry hygiene)", () => {
    writeAtomMarker(mk({ summaryTs: "1.1" }));
    writeAtomMarker(mk({ summaryTs: "2.2" })); // same threadKey C1:1.1
    assert.equal(readAtomMarker("C1", "1.1"), undefined, "stale marker removed");
    assert.ok(readAtomMarker("C1", "2.2"), "new marker kept");
  });
  it("sweep removes markers older than maxAge", () => {
    writeAtomMarker(mk({ at: 1000 }));
    const removed = sweepStaleAtomMarkers(100, () => 2000);
    assert.equal(removed, 1);
  });
});
