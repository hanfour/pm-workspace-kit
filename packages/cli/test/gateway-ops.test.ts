import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildStatusReport } from "../src/commands/gateway/ops";
import { stopCmdImpl, type OpsDeps } from "../src/commands/gateway/ops";
import { restartCmdImpl, type RestartDeps } from "../src/commands/gateway/ops";
import { writeRunState } from "../src/gateway/run-state";

// Never point HOME back at the operator's home. Test files run in separate
// processes, so restoring buys nothing — and it opens a window that has
// already caused an outage: a cancelled test's abandoned continuation resumes
// AFTER afterEach, sees the real HOME, and writes to the live ~/.pmk. On
// 2026-08-04 that overwrote the gateway config with test fixtures and took
// the bot down. ORIG_HOME is a throwaway directory, never the real one.
const ORIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-safe-home-"));
process.env.HOME = ORIG_HOME;
describe("gateway status (persisted)", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-ops-")); process.env.HOME = tmp; });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); process.env.HOME = ORIG_HOME; });

  it("dead pid → 🔴 down; never executes a {cmd} secret", () => {
    const sentinel = path.join(tmp, "RAN");
    fs.mkdirSync(path.join(tmp, ".pmk"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".pmk", "gateway.json"), JSON.stringify({
      version: 1, admins: [], blocklist: [],
      audience: { default: "biz", users: {}, channels: {} },
      escalation: { default: [], repos: {} },
      slack: { appToken: { cmd: `touch ${sentinel}` }, botToken: "xoxb-x" },
    }));
    writeRunState({ pid: 2_000_000_000, startedAt: 1, phase: "ready", supervised: null });
    const r = buildStatusReport(Date.now());
    assert.equal(r.level, "down");
    assert.equal(fs.existsSync(sentinel), false, "status must NOT run the {cmd} secret");
  });

  it("alive pid + fresh heartbeat → caps at 🟡 (CLI has no live socket)", () => {
    writeRunState({ pid: process.pid, startedAt: Date.now() - 5000, phase: "ready", supervised: null });
    fs.mkdirSync(path.join(tmp, ".pmk", "gateway"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".pmk", "gateway", "heartbeat"), String(Date.now()));
    const r = buildStatusReport(Date.now());
    assert.equal(r.level, "degraded");
    assert.match(r.text, /live socket unknown/);
  });
});

describe("gateway stop", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-stop-")); process.env.HOME = tmp; });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); process.env.HOME = ORIG_HOME; });

  function deps(over: Partial<OpsDeps> = {}): OpsDeps & { calls: string[][] } {
    const calls: string[][] = [];
    return { calls, execFile: (f, a) => { calls.push([f, ...a]); }, kill: () => {}, sleep: async () => {}, loaded: () => false, ...over };
  }

  it("not running, not installed → message, no launchctl/kill", async () => {
    const d = deps();
    const out = await stopCmdImpl(d);
    assert.match(out, /not running/);
    assert.equal(d.calls.length, 0);
  });

  it("loaded launchd service → launchctl bootout argv", async () => {
    writeRunState({ pid: process.pid, startedAt: 1, phase: "ready", supervised: "launchd", serviceLabel: "com.pmk.gateway" });
    const d = deps();
    await stopCmdImpl(d);
    assert.deepEqual(d.calls[0], ["launchctl", "bootout", `gui/${process.getuid!()}/com.pmk.gateway`]);
  });

  it("standalone live → SIGTERM then poll to exit", async () => {
    writeRunState({ pid: process.pid, startedAt: 1, phase: "ready", supervised: null });
    let alive = true;
    const d = deps({ kill: (p, sig) => { if (sig === "SIGTERM") { alive = false; } else if (!alive) throw new Error("dead"); } });
    const out = await stopCmdImpl(d);
    assert.match(out, /stopped/i);
  });
});

describe("gateway restart", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-restart-")); process.env.HOME = tmp; });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); process.env.HOME = ORIG_HOME; });

  function base(over: Partial<RestartDeps> & { calls?: string[][] } = {}): RestartDeps & { calls: string[][] } {
    const calls = over.calls ?? [];
    return {
      calls,
      execFile: (f, a) => calls.push([f, ...a]),
      kill: () => {}, sleep: async () => {},
      loaded: () => false,
      spawnDetached: () => 999,
      readReady: () => undefined,
      ...over,
    } as RestartDeps & { calls: string[][] };
  }

  it("plist installed but NOT loaded → launchctl bootstrap (not kickstart)", async () => {
    fs.mkdirSync(path.join(tmp, "Library", "LaunchAgents"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "Library", "LaunchAgents", "com.pmk.gateway.plist"), "<plist/>");
    const d = base({ loaded: () => false });
    await restartCmdImpl(d);
    assert.equal(d.calls[0][1], "bootstrap");
  });

  it("loaded service → kickstart -k targets SERVICE_LABEL when no custom label", async () => {
    const d = base({ loaded: () => true });
    await restartCmdImpl(d);
    assert.deepEqual(d.calls[0].slice(1, 3), ["kickstart", "-k"]);
    assert.match(d.calls[0][3], /com\.pmk\.gateway/);
  });

  it("loaded service with custom serviceLabel → kickstart targets custom label", async () => {
    writeRunState({ pid: process.pid, startedAt: 1, phase: "ready", supervised: "launchd", serviceLabel: "com.myorg.pmk" });
    const d = base({ loaded: () => true });
    await restartCmdImpl(d);
    assert.deepEqual(d.calls[0].slice(1, 3), ["kickstart", "-k"]);
    assert.match(d.calls[0][3], /com\.myorg\.pmk/);
  });

  it("standalone → detached spawn; success ONLY on phase ready", async () => {
    writeRunState({ pid: process.pid, startedAt: 1, phase: "ready", supervised: null });
    let spawned = false; let polls = 0;
    const out = await restartCmdImpl(base({
      kill: () => { throw new Error("dead"); }, // already gone after SIGTERM
      loaded: () => false,
      spawnDetached: () => { spawned = true; return 777; },
      readReady: () => (++polls >= 2 ? { pid: 777, phase: "ready" } : { pid: 777, phase: "starting" }),
    }));
    assert.equal(spawned, true);
    assert.match(out, /restarted/i);
  });

  it("standalone start never reaches ready → failure message", async () => {
    const out = await restartCmdImpl(base({
      loaded: () => false,
      spawnDetached: () => 777,
      readReady: () => ({ pid: 777, phase: "starting" }), // never ready
    }));
    assert.match(out, /may have failed/i);
  });
});
