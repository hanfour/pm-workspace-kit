import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { SocketHealth } from "../src/gateway/socket-health";

function harness(overrides: Partial<{ reconnect: () => Promise<void> }> = {}) {
  let now = 0;
  const events: string[] = [];
  const health = new SocketHealth(0);
  let exited: number | null = null;
  let terminated = 0;
  return {
    health,
    advance: (ms: number) => { now += ms; },
    at: () => now,
    set: (ms: number) => { now = ms; },
    log: events,
    exited: () => exited,
    terminated: () => terminated,
    deps: {
      health,
      reconnect: overrides.reconnect ?? (async () => { /* success */ }),
      terminate: async () => { terminated += 1; },
      exit: (code: number) => { exited = code; },
      now: () => now,
      onLog: (m: string) => events.push(m),
      reconnectTimeoutMs: 1_000,
    },
  };
}

describe("SocketWatchdog", () => {
  it("on unhealthy, forces one reconnect (resets pong evidence, sets pending)", async () => {
    const { SocketWatchdog } = await import("../src/gateway/slack/socket-watchdog");
    const h = harness();
    h.health.recordConnState("reconnecting", 0);
    h.set(61_000); // unstable past limit → unhealthy
    const wd = new SocketWatchdog(h.deps);
    await wd.tick();
    assert.equal(h.terminated(), 0);
    assert.equal(h.exited(), null);
  });

  it("sustained stability after a reconnect resets the failure counter (no exit)", async () => {
    const { SocketWatchdog } = await import("../src/gateway/slack/socket-watchdog");
    const h = harness();
    const wd = new SocketWatchdog(h.deps);
    h.health.recordConnState("reconnecting", 0);
    h.set(61_000); await wd.tick();                 // reconnect issued, pending
    h.health.recordConnState("connected", h.at());  // recovers
    h.set(h.at() + 200_000); await wd.tick();        // > 180s stable → reset
    assert.equal(h.exited(), null);
  });

  it("flapping reconnects reach M and loud-exit on the next unhealthy tick", async () => {
    const { SocketWatchdog } = await import("../src/gateway/slack/socket-watchdog");
    const h = harness();
    const wd = new SocketWatchdog(h.deps);
    const flap = async () => {
      h.health.recordConnState("reconnecting", h.at());
      h.set(h.at() + 61_000);                 // unhealthy
      await wd.tick();                        // (pending? count) then reconnect
      h.health.recordConnState("connected", h.at()); // brief recover (start ok)
      h.set(h.at() + 1_000);                  // < 180s stable
    };
    await flap(); await flap(); await flap(); // 3 reconnects, each unstable
    h.health.recordConnState("reconnecting", h.at());
    h.set(h.at() + 61_000);
    await wd.tick();                          // confirms 3rd failure → exit
    assert.equal(h.terminated(), 1);
    assert.equal(h.exited(), 1);
  });

  it("a reconnect that throws counts as an immediate failed attempt", async () => {
    const { SocketWatchdog } = await import("../src/gateway/slack/socket-watchdog");
    const h = harness({ reconnect: async () => { throw new Error("boom"); } });
    const wd = new SocketWatchdog(h.deps);
    for (let i = 0; i < 3; i++) {
      h.health.recordConnState("reconnecting", h.at());
      h.set(h.at() + 61_000);
      await wd.tick();
    }
    h.health.recordConnState("reconnecting", h.at());
    h.set(h.at() + 61_000);
    await wd.tick();
    assert.equal(h.exited(), 1);
  });

  it("a reconnect that never settles is timed out and counts as failed", async () => {
    const { SocketWatchdog } = await import("../src/gateway/slack/socket-watchdog");
    const h = harness({ reconnect: () => new Promise(() => {}) });
    h.deps.reconnectTimeoutMs = 50;
    const wd = new SocketWatchdog(h.deps);
    h.health.recordConnState("reconnecting", h.at());
    h.set(h.at() + 61_000);
    await wd.tick();
    assert.ok(h.log.some((m) => /reconnect failed|timed out/i.test(m)));
  });

  it("still exits even if the loud-exit alert (terminate) rejects", async () => {
    const { SocketWatchdog } = await import("../src/gateway/slack/socket-watchdog");
    const h = harness({ reconnect: async () => { throw new Error("boom"); } });
    h.deps.terminate = async () => { throw new Error("slack down"); };
    const wd = new SocketWatchdog(h.deps);
    for (let i = 0; i < 3; i++) {
      h.health.recordConnState("reconnecting", h.at());
      h.set(h.at() + 61_000);
      await wd.tick();
    }
    h.health.recordConnState("reconnecting", h.at());
    h.set(h.at() + 61_000);
    await wd.tick(); // failures=3 → loud exit; terminate rejects but exit must still fire
    assert.equal(h.exited(), 1);
  });
});
