import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { reserveAudioQuota, releaseAudioQuota } from "../src/gateway/audio/quota";

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

describe("releaseAudioQuota", () => {
  let tmp: string;
  const fixedNow = () => Date.parse("2026-06-26T10:00:00Z");
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-q-")); process.env.HOME = tmp; });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (ORIG) process.env.HOME = ORIG; });

  it("reserve 50 then release 50: next reserve of 120 succeeds", () => {
    reserveAudioQuota({ userId: "U1", minutes: 50, perUserDailyMinutes: 120, globalDailyMinutes: 600, now: fixedNow });
    releaseAudioQuota({ userId: "U1", minutes: 50, now: fixedNow });
    // Usage should be back to 0 — a full 120-minute reserve should succeed.
    const r = reserveAudioQuota({ userId: "U1", minutes: 120, perUserDailyMinutes: 120, globalDailyMinutes: 600, now: fixedNow });
    assert.equal(r.ok, true);
  });

  it("floor-at-0: releasing more than reserved does not go negative (discriminating)", () => {
    // Release 50 from a zero baseline. A floored impl clamps to 0; an unfloored impl
    // would store -50 globally and per-user.
    releaseAudioQuota({ userId: "U1", minutes: 50, now: fixedNow });
    // Now try to reserve 175 against a globalDailyMinutes of 150.
    // Floored (0 + 175 = 175 > 150)  → deny  (correct)
    // Unfloored (-50 + 175 = 125 ≤ 150) → allow (wrong)
    const r = reserveAudioQuota({ userId: "U1", minutes: 175, perUserDailyMinutes: 9999, globalDailyMinutes: 150, now: fixedNow });
    assert.equal(r.ok, false, "global cap must deny: floored baseline 0+175>150");
  });
});
