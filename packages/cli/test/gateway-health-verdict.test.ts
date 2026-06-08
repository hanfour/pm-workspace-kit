import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { heartbeatBand, verdict } from "../src/gateway/health-verdict";

describe("heartbeatBand", () => {
  it("fresh < 30s, aging 30–60s, stale >= 60s", () => {
    assert.equal(heartbeatBand(10_000), "fresh");
    assert.equal(heartbeatBand(45_000), "aging");
    assert.equal(heartbeatBand(60_000), "stale");
    assert.equal(heartbeatBand(undefined), "stale");
  });
  it("boundary: 29_999ms is fresh, 30_000ms is aging", () => {
    assert.equal(heartbeatBand(29_999), "fresh");
    assert.equal(heartbeatBand(30_000), "aging");
  });
});

describe("verdict", () => {
  it("down when pid dead or heartbeat stale", () => {
    assert.equal(verdict({ pidAlive: false, heartbeatAge: 1000 }).level, "down");
    assert.equal(verdict({ pidAlive: true, heartbeatAge: 90_000 }).level, "down");
  });
  it("with live inputs: healthy vs degraded", () => {
    assert.equal(verdict({ pidAlive: true, heartbeatAge: 5_000, live: { socketState: "connected", flaps: 0 } }).level, "healthy");
    assert.equal(verdict({ pidAlive: true, heartbeatAge: 5_000, live: { socketState: "reconnecting", flaps: 0 } }).level, "degraded");
    assert.equal(verdict({ pidAlive: true, heartbeatAge: 5_000, live: { socketState: "connected", flaps: 2 } }).level, "degraded");
    assert.equal(verdict({ pidAlive: true, heartbeatAge: 45_000, live: { socketState: "connected", flaps: 0 } }).level, "degraded");
  });
  it("pid-dead wins even with healthy live inputs", () => {
    assert.equal(verdict({ pidAlive: false, heartbeatAge: 5_000, live: { socketState: "connected", flaps: 0 } }).level, "down");
  });
  it("without live inputs (CLI): never healthy — caps at degraded when up", () => {
    const v = verdict({ pidAlive: true, heartbeatAge: 5_000 });
    assert.equal(v.level, "degraded");
    assert.match(v.note, /live socket unknown/);
  });
});
