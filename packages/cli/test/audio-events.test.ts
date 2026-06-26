// packages/cli/test/audio-events.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendGatewayEvent, readGatewayEvents } from "../src/gateway/events";

const ORIG = process.env.HOME;
describe("audio.* events round-trip", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-aev-")); process.env.HOME = tmp; });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (ORIG) process.env.HOME = ORIG; });

  it("writes and reads audio.transcribed/summarized/failed", () => {
    appendGatewayEvent({ type: "audio.transcribed", actor: "U1", durationSec: 600, chunks: 1, ms: 1234, estimatedUsd: 0.06 } as never);
    appendGatewayEvent({ type: "audio.summarized", actor: "U1", mode: "long" } as never);
    appendGatewayEvent({ type: "audio.failed", actor: "U1", reason: "transcribe-failed" } as never);
    const types = readGatewayEvents().map((e: { type: string }) => e.type);
    assert.ok(types.includes("audio.transcribed"));
    assert.ok(types.includes("audio.summarized"));
    assert.ok(types.includes("audio.failed"));
  });
});
