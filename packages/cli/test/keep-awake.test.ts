import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { EventEmitter } from "node:events";

function fakeSpawn() {
  const calls: Array<{ cmd: string; args: string[]; opts: unknown }> = [];
  const children: Array<EventEmitter & { killed: boolean; kill: () => void; unref: () => void }> = [];
  const spawn = ((cmd: string, args: string[], opts: unknown) => {
    calls.push({ cmd, args, opts });
    const child = Object.assign(new EventEmitter(), {
      killed: false,
      kill() { this.killed = true; },
      unref() {},
    });
    children.push(child);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn, calls, children };
}

describe("startKeepAwake", () => {
  it("spawns caffeinate -is -w <pid> on darwin and stop() kills it", async () => {
    const { startKeepAwake } = await import("../src/gateway/keep-awake");
    const f = fakeSpawn();
    const h = startKeepAwake({ platform: "darwin", pid: 4242, spawn: f.spawn, flagsEnv: undefined });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].cmd, "caffeinate");
    assert.deepEqual(f.calls[0].args, ["-is", "-w", "4242"]);
    assert.deepEqual((f.calls[0].opts as { stdio: string }).stdio, "ignore");
    h.stop();
    assert.equal(f.children[0].killed, true);
  });

  it("honours PMK_GATEWAY_CAFFEINATE_FLAGS override, always appends -w", async () => {
    const { startKeepAwake } = await import("../src/gateway/keep-awake");
    const f = fakeSpawn();
    startKeepAwake({ platform: "darwin", pid: 7, spawn: f.spawn, flagsEnv: "-dimsu" });
    assert.deepEqual(f.calls[0].args, ["-dimsu", "-w", "7"]);
  });

  it("is a no-op on non-darwin", async () => {
    const { startKeepAwake } = await import("../src/gateway/keep-awake");
    const f = fakeSpawn();
    const h = startKeepAwake({ platform: "linux", pid: 1, spawn: f.spawn });
    assert.equal(f.calls.length, 0);
    h.stop();
  });

  it("swallows a sync spawn throw and still returns a handle", async () => {
    const { startKeepAwake } = await import("../src/gateway/keep-awake");
    const logs: string[] = [];
    const throwingSpawn = (() => { throw new Error("ENOENT"); }) as unknown as typeof import("node:child_process").spawn;
    const h = startKeepAwake({ platform: "darwin", pid: 1, spawn: throwingSpawn, onLog: (m) => logs.push(m) });
    assert.ok(typeof h.stop === "function");
    assert.ok(logs.some((m) => /caffeinate/i.test(m)));
  });

  it("warns on an unexpected child exit (not via stop)", async () => {
    const { startKeepAwake } = await import("../src/gateway/keep-awake");
    const f = fakeSpawn();
    const logs: string[] = [];
    startKeepAwake({ platform: "darwin", pid: 1, spawn: f.spawn, onLog: (m) => logs.push(m) });
    f.children[0].emit("exit", 1);
    assert.ok(logs.some((m) => /unexpectedly|NOT throttle/i.test(m)));
  });
});
