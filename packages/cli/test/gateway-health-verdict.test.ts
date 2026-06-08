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
  it("with live inputs: gates on current/recent-window signals, NOT lifetime flaps", () => {
    const fresh = 5_000;
    const ok = { socketState: "connected" as const, pongTimeoutsInWindow: 0, unstableMs: 0 };
    // healthy: connected with a clean recent window
    assert.equal(verdict({ pidAlive: true, heartbeatAge: fresh, live: ok }).level, "healthy");
    // the bug we're fixing: a tolerated transient pong-timeout (below threshold) — and any
    // historical reconnect, which is no longer even an input — must NOT degrade a connected socket
    assert.equal(verdict({ pidAlive: true, heartbeatAge: fresh, live: { ...ok, pongTimeoutsInWindow: 2 } }).level, "healthy");
    // degraded: socket not currently connected
    assert.equal(verdict({ pidAlive: true, heartbeatAge: fresh, live: { socketState: "reconnecting", pongTimeoutsInWindow: 0, unstableMs: 5_000 } }).level, "degraded");
    // degraded: pong-timeout flood within the window (>= threshold)
    assert.equal(verdict({ pidAlive: true, heartbeatAge: fresh, live: { ...ok, pongTimeoutsInWindow: 3 } }).level, "degraded");
    // degraded: heartbeat aging even with a clean socket
    assert.equal(verdict({ pidAlive: true, heartbeatAge: 45_000, live: ok }).level, "degraded");
  });
  it("pid-dead wins even with healthy live inputs", () => {
    assert.equal(verdict({ pidAlive: false, heartbeatAge: 5_000, live: { socketState: "connected", pongTimeoutsInWindow: 0, unstableMs: 0 } }).level, "down");
  });
  it("without live inputs (CLI): never healthy — caps at degraded when up", () => {
    const v = verdict({ pidAlive: true, heartbeatAge: 5_000 });
    assert.equal(v.level, "degraded");
    assert.match(v.note, /live socket unknown/);
  });
});
