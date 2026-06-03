import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

describe("SocketHealth", () => {
  it("flags unhealthy on a pong-timeout flood and healthy on an isolated timeout", async () => {
    const { SocketHealth } = await import("../src/gateway/socket-health");
    const h = new SocketHealth(0);
    h.recordConnState("connected", 0);
    h.recordPongTimeout(1_000);
    assert.equal(h.assess(2_000), "healthy"); // 1 < threshold
    h.recordPongTimeout(2_000);
    h.recordPongTimeout(3_000);
    assert.equal(h.assess(4_000), "unhealthy"); // 3 within 60s
  });

  it("prunes pong-timeouts outside the 60s window", async () => {
    const { SocketHealth } = await import("../src/gateway/socket-health");
    const h = new SocketHealth(0);
    h.recordConnState("connected", 0);
    h.recordPongTimeout(1_000);
    h.recordPongTimeout(2_000);
    h.recordPongTimeout(3_000);
    assert.equal(h.assess(240_000), "healthy");
  });

  it("flags unhealthy when not connected past UNSTABLE_CONN_LIMIT_MS", async () => {
    const { SocketHealth } = await import("../src/gateway/socket-health");
    const h = new SocketHealth(0);
    h.recordConnState("reconnecting", 0);
    assert.equal(h.assess(30_000), "healthy"); // within grace
    assert.equal(h.assess(61_000), "unhealthy"); // churn past 60s
  });

  it("reset clears pong evidence but keeps the connected anchor", async () => {
    const { SocketHealth } = await import("../src/gateway/socket-health");
    const h = new SocketHealth(0);
    h.recordConnState("connected", 10_000);
    h.recordPongTimeout(11_000);
    h.recordPongTimeout(12_000);
    h.reset(13_000);
    assert.equal(h.assess(14_000), "healthy"); // pong evidence gone
    assert.equal(h.lastStableConnectedSince(14_000), 10_000); // connected anchor preserved
  });

  it("lastStableConnectedSince: null unless connected; a pong-timeout restarts the clock", async () => {
    const { SocketHealth } = await import("../src/gateway/socket-health");
    const h = new SocketHealth(0);
    h.recordConnState("connecting", 0);
    assert.equal(h.lastStableConnectedSince(5_000), null);
    h.recordConnState("connected", 10_000);
    assert.equal(h.lastStableConnectedSince(20_000), 10_000);
    h.recordPongTimeout(15_000); // single timeout while connected
    assert.equal(h.lastStableConnectedSince(20_000), 15_000); // clock restarted
    h.recordConnState("disconnected", 25_000);
    assert.equal(h.lastStableConnectedSince(30_000), null);
  });
});
