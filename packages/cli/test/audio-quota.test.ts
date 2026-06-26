import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { reserveAudioQuota } from "../src/gateway/audio/quota";

const ORIG = process.env.HOME;
describe("reserveAudioQuota", () => {
  let tmp: string;
  const fixedNow = () => Date.parse("2026-06-26T10:00:00Z");
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-q-")); process.env.HOME = tmp; });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (ORIG) process.env.HOME = ORIG; });

  it("allows within both caps and accrues", () => {
    const a = reserveAudioQuota({ userId: "U1", minutes: 50, perUserDailyMinutes: 120, globalDailyMinutes: 600, now: fixedNow });
    assert.equal(a.ok, true);
    const b = reserveAudioQuota({ userId: "U1", minutes: 80, perUserDailyMinutes: 120, globalDailyMinutes: 600, now: fixedNow });
    assert.equal(b.ok, false); // 50+80 > 120 per-user
  });
  it("enforces the global cap across users", () => {
    reserveAudioQuota({ userId: "U1", minutes: 100, perUserDailyMinutes: 120, globalDailyMinutes: 150, now: fixedNow });
    const r = reserveAudioQuota({ userId: "U2", minutes: 100, perUserDailyMinutes: 120, globalDailyMinutes: 150, now: fixedNow });
    assert.equal(r.ok, false);
  });
});
