import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  writeRunState,
  readGatewayRunStateRaw,
  gatewayLiveRunState,
  installedPlist,
  serviceLabelValid,
} from "../src/gateway/run-state";

// Never point HOME back at the operator's home. Test files run in separate
// processes, so restoring buys nothing — and it opens a window that has
// already caused an outage: a cancelled test's abandoned continuation resumes
// AFTER afterEach, sees the real HOME, and writes to the live ~/.pmk. On
// 2026-08-04 that overwrote the gateway config with test fixtures and took
// the bot down. ORIG_HOME is a throwaway directory, never the real one.
const ORIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-safe-home-"));
process.env.HOME = ORIG_HOME;
describe("gateway run-state", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-runstate-"));
    process.env.HOME = tmp;
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env.HOME = ORIG_HOME;
  });

  it("writeRunState then readRaw round-trips (incl phase)", () => {
    writeRunState({ pid: 4242, startedAt: 1000, phase: "starting", supervised: null });
    const raw = readGatewayRunStateRaw();
    assert.equal(raw?.pid, 4242);
    assert.equal(raw?.phase, "starting");
    assert.equal(raw?.supervised, null);
  });

  it("readRaw returns a STALE entry (dead pid) verbatim; live returns undefined", () => {
    writeRunState({ pid: 2_000_000_000, startedAt: 1, phase: "ready", supervised: null });
    assert.ok(readGatewayRunStateRaw(), "raw still returns the stale row");
    assert.equal(gatewayLiveRunState(), undefined, "live rejects a dead pid");
  });

  it("live returns the row when pid is alive (this process)", () => {
    writeRunState({ pid: process.pid, startedAt: 1, phase: "ready", supervised: null });
    assert.equal(gatewayLiveRunState()?.pid, process.pid);
  });

  it("installedPlist undefined when no plist; serviceLabelValid guards the label", () => {
    assert.equal(installedPlist(), undefined);
    assert.equal(serviceLabelValid("com.pmk.gateway"), true);
    assert.equal(serviceLabelValid("bad label"), false);
    assert.equal(serviceLabelValid("../evil"), false);
  });
});
