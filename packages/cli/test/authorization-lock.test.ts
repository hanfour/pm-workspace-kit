// packages/cli/test/authorization-lock.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  withAuthorizationLock,
  acquireAuthorizationLockSync,
  releaseAuthorizationLock,
  authorizationLockPath,
  AuthorizationLockBusyError,
} from "../src/gateway/authorization-lock";

const ORIG_HOME = process.env.HOME; // gatewayDir() is HOME-based
let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-authlock-"));
  process.env.HOME = tmp;
});
afterEach(() => {
  if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("authorization-lock (#90)", () => {
  it("withAuthorizationLock runs the section and releases the lock", async () => {
    let ran = false;
    const out = await withAuthorizationLock(async () => {
      ran = true;
      assert.ok(fs.existsSync(authorizationLockPath()), "lock dir held during section");
      return 42;
    });
    assert.equal(out, 42);
    assert.equal(ran, true);
    assert.equal(fs.existsSync(authorizationLockPath()), false, "released after section");
  });

  it("releases the lock when the section throws", async () => {
    await assert.rejects(
      () => withAuthorizationLock(async () => { throw new Error("boom"); }),
      /boom/,
    );
    assert.equal(fs.existsSync(authorizationLockPath()), false);
  });

  it("serializes two concurrent async sections (mutual exclusion)", async () => {
    const events: string[] = [];
    const a = withAuthorizationLock(async () => {
      events.push("a-start");
      await sleep(120);
      events.push("a-end");
    });
    await sleep(20); // let A acquire first
    const b = withAuthorizationLock(async () => {
      events.push("b-start");
      await sleep(10);
      events.push("b-end");
    });
    await Promise.all([a, b]);
    assert.deepEqual(events, ["a-start", "a-end", "b-start", "b-end"]);
  });

  it("sync acquire during a SAME-PROCESS async hold fails fast (no event-loop starvation)", async () => {
    const holder = withAuthorizationLock(async () => { await sleep(300); });
    await sleep(20);
    // Spinning here would starve the async holder on our own event loop —
    // the design mandates an immediate, honest Busy error instead.
    const t0 = Date.now();
    assert.throws(
      () => acquireAuthorizationLockSync({ acquireTimeoutMs: 5_000 }),
      AuthorizationLockBusyError,
    );
    assert.ok(Date.now() - t0 < 200, "must fail fast, not wait out the timeout");
    await holder;
  });

  it("sync acquire spins for a FOREIGN live holder and throws after the timeout", () => {
    // Forge a fresh lock owned by another live process (our parent shell).
    const lock = authorizationLockPath();
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.mkdirSync(lock, { mode: 0o700 });
    fs.writeFileSync(path.join(lock, "owner"), JSON.stringify({ pid: process.ppid, acquiredAt: Date.now() }), { mode: 0o600 });
    const t0 = Date.now();
    assert.throws(
      () => acquireAuthorizationLockSync({ acquireTimeoutMs: 150, pollMs: 25 }),
      AuthorizationLockBusyError,
    );
    assert.ok(Date.now() - t0 >= 140, "must have spun until the deadline");
    fs.rmSync(lock, { recursive: true, force: true });
  });

  it("takes over a lock whose owner pid is dead", async () => {
    // Forge a lock owned by a dead pid.
    const lock = authorizationLockPath();
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.mkdirSync(lock, { mode: 0o700 });
    fs.writeFileSync(path.join(lock, "owner"), JSON.stringify({ pid: 999999999, acquiredAt: Date.now() }), { mode: 0o600 });
    let ran = false;
    await withAuthorizationLock(async () => { ran = true; }, { acquireTimeoutMs: 2_000 });
    assert.equal(ran, true, "dead-owner lock must be taken over");
  });

  it("takes over a lock held beyond the staleness bound even if the pid is alive", async () => {
    const lock = authorizationLockPath();
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.mkdirSync(lock, { mode: 0o700 });
    // Owned by THIS live process but acquired far in the past.
    fs.writeFileSync(path.join(lock, "owner"), JSON.stringify({ pid: process.pid, acquiredAt: Date.now() - 10 * 60_000 }), { mode: 0o600 });
    let ran = false;
    await withAuthorizationLock(async () => { ran = true; }, { acquireTimeoutMs: 2_000, staleMs: 60_000 });
    assert.equal(ran, true, "stale-held lock must be taken over");
  });
});
