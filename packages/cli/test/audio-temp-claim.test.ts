import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeJobTempDir, sweepStaleAudioTemp } from "../src/gateway/audio/temp";
import { claimAudio, releaseAudio, sweepStaleAudioClaims } from "../src/gateway/audio/claim";

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

  it("sweepStaleAudioClaims removes old claims and keeps fresh ones", () => {
    // Create one claim file (real timestamp = now).
    assert.equal(claimAudio("OLD_CLAIM"), true);

    // Sweep with a now() 25 hours in the future → should remove the claim.
    const futureNow = () => Date.now() + 25 * 3600 * 1000;
    const removed = sweepStaleAudioClaims(24 * 3600 * 1000, futureNow);
    assert.ok(removed >= 1, "should have removed at least 1 stale claim");
    // Claim should be gone — claimAudio should succeed again.
    assert.equal(claimAudio("OLD_CLAIM"), true, "stale claim should have been removed");
    releaseAudio("OLD_CLAIM");
  });

  it("sweepStaleAudioClaims keeps fresh claims", () => {
    assert.equal(claimAudio("FRESH_CLAIM"), true);

    // Sweep with a now() only 1 hour in the future — within maxAge of 24h.
    const slightlyFuture = () => Date.now() + 1 * 3600 * 1000;
    const removed = sweepStaleAudioClaims(24 * 3600 * 1000, slightlyFuture);
    assert.equal(removed, 0, "fresh claim should not be removed");
    // Claim is still active — a second claimAudio should return false.
    assert.equal(claimAudio("FRESH_CLAIM"), false, "fresh claim should still be active");
    releaseAudio("FRESH_CLAIM");
  });

  it("rethrows a non-EEXIST error from claimAudio (EACCES when dir is read-only)", () => {
    // Make the claims directory non-writable so writeFileSync fails with EACCES
    // (not EEXIST), which must be rethrown rather than silently returning false.
    const claimsDir = path.join(tmp, ".pmk", "gateway", "audio-claims");
    fs.mkdirSync(claimsDir, { recursive: true });
    fs.chmodSync(claimsDir, 0o555);
    try {
      assert.throws(
        () => claimAudio("NOPERM"),
        (err: unknown) => {
          const code = (err as NodeJS.ErrnoException).code;
          assert.notEqual(code, "EEXIST", "non-EEXIST errors must be rethrown, not swallowed");
          return true;
        },
      );
    } finally {
      fs.chmodSync(claimsDir, 0o700); // restore so afterEach can clean up
    }
  });
});
