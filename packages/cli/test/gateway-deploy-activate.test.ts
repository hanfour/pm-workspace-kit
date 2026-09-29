import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { useIsolatedHome } from "./helpers/isolated-home";
import { activateRelease, rollbackRelease, type ActivateDeps } from "../src/gateway/deploy/activate";
import { pointLink, readLink, releasesRoot, writeReleaseInfo } from "../src/gateway/deploy/paths";

const OLD = "0.44.0-2fa1497";
const NEW = "0.45.0-abcdef0";

function makeRelease(root: string, name: string): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  writeReleaseInfo(dir, { ref: "HEAD", sha: "a".repeat(40), version: "0", builtAt: "2026-09-21T00:00:00.000Z", nodeVersion: "v22" });
}

/**
 * Fake service. `readyAfterRestart[i]` says whether the i-th restart leads to
 * a ready process. Each restart gets a fresh pid.
 */
function fakeService(readyAfterRestart: (boolean | Error)[], runsCurrent = true): { deps: ActivateDeps; restarts: () => number } {
  let restarts = 0;
  let pid = 100;
  let phase = "ready";
  const deps: ActivateDeps = {
    serviceRunsCurrent: () => runsCurrent,
    sleep: async () => {},
    restart: async () => {
      const ok = readyAfterRestart[restarts] ?? false;
      restarts += 1;
      if (ok instanceof Error) throw ok;
      pid += 1;
      phase = ok ? "ready" : "starting";
      return "restarted";
    },
    readReady: () => ({ pid, phase }),
  };
  return { deps, restarts: () => restarts };
}

describe("activateRelease", () => {
  const home = useIsolatedHome("pmk-deploy-activate-");
  const setup = (): string => {
    const root = releasesRoot(home.dir());
    makeRelease(root, OLD);
    makeRelease(root, NEW);
    return root;
  };

  it("flips current, records previous, restarts once", async () => {
    const root = setup();
    pointLink(root, "current", OLD);
    const svc = fakeService([true]);
    const r = await activateRelease({ root, name: NEW }, svc.deps);
    assert.equal(r.outcome, "activated");
    assert.equal(r.previous, OLD);
    assert.equal(readLink(root, "current"), NEW);
    assert.equal(readLink(root, "previous"), OLD);
    assert.equal(svc.restarts(), 1);
  });

  it("first-ever deploy: no previous link is created", async () => {
    const root = setup();
    const r = await activateRelease({ root, name: NEW }, fakeService([true]).deps);
    assert.equal(r.outcome, "activated");
    assert.equal(readLink(root, "previous"), undefined);
  });

  it("already current: nothing changes and nothing restarts", async () => {
    const root = setup();
    pointLink(root, "current", NEW);
    const svc = fakeService([true]);
    const r = await activateRelease({ root, name: NEW }, svc.deps);
    assert.equal(r.outcome, "already-current");
    assert.equal(svc.restarts(), 0);
  });

  it("refuses a release that was never built", async () => {
    const root = setup();
    await assert.rejects(activateRelease({ root, name: "0.46.0-1111111" }, fakeService([true]).deps), /is not built/);
    assert.equal(readLink(root, "current"), undefined);
  });

  it("not ready in time: restores both links and restarts again", async () => {
    const root = setup();
    makeRelease(root, "0.43.0-0000000");
    pointLink(root, "previous", "0.43.0-0000000");
    pointLink(root, "current", OLD);
    const svc = fakeService([false, true]);
    const r = await activateRelease({ root, name: NEW }, svc.deps);
    assert.equal(r.outcome, "rolled-back");
    assert.equal(readLink(root, "current"), OLD);
    assert.equal(readLink(root, "previous"), "0.43.0-0000000");
    assert.equal(svc.restarts(), 2);
  });

  it("a throwing restart rolls back without polling that attempt", async () => {
    const root = setup();
    pointLink(root, "current", OLD);
    const svc = fakeService([new Error("kickstart failed"), true]);
    let polls = 0;
    const r = await activateRelease({ root, name: NEW }, {
      ...svc.deps, sleep: async () => { polls += 1; },
    });
    assert.equal(r.outcome, "rolled-back");
    assert.equal(readLink(root, "current"), OLD);
    assert.match(r.message, /kickstart failed/);
    assert.equal(svc.restarts(), 2);
    assert.equal(polls, 1);
  });

  it("every restart throws: resolves failed with restored links and no polling", async () => {
    const root = setup();
    pointLink(root, "current", OLD);
    const svc = fakeService([new Error("kickstart failed"), new Error("rollback failed")]);
    const r = await activateRelease({ root, name: NEW }, {
      ...svc.deps, sleep: async () => { assert.fail("must not poll a throwing restart"); },
    });
    assert.equal(r.outcome, "failed");
    assert.equal(readLink(root, "current"), OLD);
    assert.equal(readLink(root, "previous"), undefined);
    assert.match(r.message, /kickstart failed/);
    assert.match(r.message, /rollback failed/);
    assert.equal(svc.restarts(), 2);
  });

  it("rollback removes previous when it did not exist before activation", async () => {
    const root = setup();
    pointLink(root, "current", OLD);
    const r = await activateRelease({ root, name: NEW }, fakeService([false, true]).deps);
    assert.equal(r.outcome, "rolled-back");
    assert.equal(readLink(root, "current"), OLD);
    assert.equal(readLink(root, "previous"), undefined);
  });

  it("rollback restart also fails: outcome failed, links still restored", async () => {
    const root = setup();
    pointLink(root, "current", OLD);
    const r = await activateRelease({ root, name: NEW }, fakeService([false, false]).deps);
    assert.equal(r.outcome, "failed");
    assert.equal(readLink(root, "current"), OLD);
    assert.equal(readLink(root, "previous"), undefined);
    assert.match(r.message, /gateway\.err\.log/);
  });

  it("first-ever deploy that never becomes ready: failed, nothing to roll back to", async () => {
    const root = setup();
    const svc = fakeService([false]);
    const r = await activateRelease({ root, name: NEW }, svc.deps);
    assert.equal(r.outcome, "failed");
    assert.equal(svc.restarts(), 1);
  });

  it("LaunchAgent does not run releases/current: links flip, no restart", async () => {
    const root = setup();
    const svc = fakeService([true], false);
    const r = await activateRelease({ root, name: NEW }, svc.deps);
    assert.equal(r.outcome, "links-only");
    assert.equal(readLink(root, "current"), NEW);
    assert.equal(svc.restarts(), 0);
    assert.match(r.message, /install-service --force/);
  });

  it("a stale ready record from the old pid does not count as success", async () => {
    const root = setup();
    pointLink(root, "current", OLD);
    const deps: ActivateDeps = {
      serviceRunsCurrent: () => true, sleep: async () => {}, restart: async () => "restarted",
      readReady: () => ({ pid: 100, phase: "ready" }), // pid never changes
    };
    const r = await activateRelease({ root, name: NEW }, deps);
    assert.notEqual(r.outcome, "activated");
  });
});

describe("rollbackRelease", () => {
  const home = useIsolatedHome("pmk-deploy-rollback-");

  it("activates previous", async () => {
    const root = releasesRoot(home.dir());
    makeRelease(root, OLD);
    makeRelease(root, NEW);
    pointLink(root, "current", NEW);
    pointLink(root, "previous", OLD);
    const r = await rollbackRelease(root, fakeService([true]).deps);
    assert.equal(r.outcome, "activated");
    assert.equal(readLink(root, "current"), OLD);
    assert.equal(readLink(root, "previous"), NEW);
  });

  it("throws when there is no previous release", async () => {
    const root = releasesRoot(home.dir());
    fs.mkdirSync(root, { recursive: true });
    await assert.rejects(rollbackRelease(root, fakeService([true]).deps), /no previous release/);
  });
});
