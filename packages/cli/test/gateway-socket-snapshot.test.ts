import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { SocketHealth } from "../src/gateway/socket-health";

describe("SocketHealth.snapshot", () => {
  it("reports state + pong-timeouts in window + unstable ms", () => {
    const h = new SocketHealth(0);
    h.recordConnState("connected", 0);
    assert.deepEqual(h.snapshot(1_000), { state: "connected", pongTimeoutsInWindow: 0, unstableMs: 0 });
    h.recordConnState("reconnecting", 2_000);
    h.recordPongTimeout(2_500);
    const s = h.snapshot(5_000);
    assert.equal(s.state, "reconnecting");
    assert.equal(s.pongTimeoutsInWindow, 1);
    assert.equal(s.unstableMs, 3_000); // 5000 - 2000 (stateSince)
  });
});

describe("SocketWatchdog.snapshot", () => {
  it("reflects flaps and confirmedFailures accurately after reconnect attempts", async () => {
    const { SocketWatchdog } = await import("../src/gateway/slack/socket-watchdog");
    let now = 0;
    const health = new SocketHealth(0);
    const wd = new SocketWatchdog({
      health,
      reconnect: async () => { /* success */ },
      terminate: async () => {},
      exit: () => {},
      now: () => now,
      onLog: () => {},
      reconnectTimeoutMs: 1_000,
    });

    // Initial snapshot: nothing has happened yet.
    assert.deepEqual(wd.snapshot(), { flaps: 0, confirmedFailures: 0 });

    // Drive first unhealthy tick → watchdog issues one reconnect (flap 1).
    health.recordConnState("reconnecting", 0);
    now = 61_000;
    await wd.tick();
    assert.deepEqual(wd.snapshot(), { flaps: 1, confirmedFailures: 0 });

    // Drive second unhealthy tick before stability window → confirms failure 1, then reconnects (flap 2).
    health.recordConnState("connected", now);
    now += 1_000; // < 180s stable — pendingEvaluation becomes a confirmed failure
    health.recordConnState("reconnecting", now);
    now += 61_000;
    await wd.tick();
    assert.deepEqual(wd.snapshot(), { flaps: 2, confirmedFailures: 1 });
  });
});
