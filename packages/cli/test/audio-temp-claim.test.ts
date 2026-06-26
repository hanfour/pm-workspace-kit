import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeJobTempDir, sweepStaleAudioTemp } from "../src/gateway/audio/temp";
import { claimAudio, releaseAudio } from "../src/gateway/audio/claim";

const ORIG = process.env.HOME;
describe("audio temp + claim", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-tc-"));
    process.env.HOME = tmp;
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (ORIG) process.env.HOME = ORIG;
  });

  it("creates a 0700 job temp dir under ~/.pmk", () => {
    const dir = makeJobTempDir("F1");
    assert.ok(fs.existsSync(dir));
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.match(dir, /\.pmk\/gateway\/audio-tmp\//);
  });
  it("claim is once-only until released", () => {
    assert.equal(claimAudio("F1"), true);
    assert.equal(claimAudio("F1"), false);
    releaseAudio("F1");
    assert.equal(claimAudio("F1"), true);
  });
  it("sweep removes stale job dirs", () => {
    const dir = makeJobTempDir("OLD");
    const future = () => Date.now() + 24 * 3600 * 1000;
    const removed = sweepStaleAudioTemp(6 * 3600 * 1000, future);
    assert.ok(removed >= 1);
    assert.equal(fs.existsSync(dir), false);
  });
});
