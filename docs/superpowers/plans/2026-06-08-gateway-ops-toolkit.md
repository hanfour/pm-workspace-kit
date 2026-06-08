# Gateway Ops Toolkit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give engineers `pmk gateway stop`/`restart`, a `/pmk admin doctor` runtime-health view + enhanced `pmk gateway status`, and a `pmk gateway install-service` launchd installer — all aware of standalone vs launchd-supervised running.

**Architecture:** A new `gateway/run-state.ts` (JSON run-state with a `phase`, plus launchd installed/loaded discovery) is the foundation. A shared `gateway/health-verdict.ts` computes 🟢/🟡/🔴 from persisted + optional live inputs. `SocketHealth`/`SocketWatchdog` get public `snapshot()` APIs; the Slack adapter exposes a `getRuntimeHealthSnapshot()` provider read at command time. CLI lifecycle commands branch on the run-state/launchd discovery; the installer generates a LaunchAgent plist with no secrets.

**Tech Stack:** TypeScript, Node `node:test` + `node:assert/strict`, `node:child_process` (`execFile`/`spawn`), launchd (`launchctl`).

**Spec:** `docs/superpowers/specs/2026-06-08-gateway-ops-toolkit-design.md`.
**Run tests:** `cd packages/cli && npm test` (typecheck:test then suite). Single file: `node --import tsx --test test/<f>.test.ts`.

---

## File Structure

- **Create** `packages/cli/src/gateway/run-state.ts` — `GatewayRunState`, `writeRunState`, `readGatewayRunStateRaw`, `gatewayLiveRunState`, `installedPlist`, `loadedService`, `serviceLabelValid`. (T1)
- **Create** `packages/cli/src/gateway/health-verdict.ts` — `heartbeatBand`, `verdict`. (T2)
- **Modify** `src/gateway/index.ts` — write `phase:"starting"` then `"ready"`; `gatewayRunningPid` derives from run-state. (T1)
- **Modify** `src/gateway/socket-health.ts` (`SocketHealth.snapshot`) + `src/gateway/slack/socket-watchdog.ts` (counters + `SocketWatchdog.snapshot`). (T3)
- **Modify** `src/commands/gateway/ops.ts` — enhanced `statusCmd`, new `stopCmd`/`restartCmd`; `src/commands/gateway/index.ts` — `stop`/`restart`/`install-service` cases. (T4–T6, T8)
- **Create** `packages/cli/src/commands/gateway/service.ts` — `installServiceCmd` + plist generator. (T8)
- **Modify** `src/gateway/slack/admin.ts` (`adminDoctor` + `doctor` case), `src/gateway/slack/slash-command.ts` + `src/gateway/slack/index.ts` (thread `getRuntimeHealthSnapshot` provider). (T7)
- **Tests:** `test/gateway-run-state.test.ts`, `test/gateway-health-verdict.test.ts`, `test/gateway-socket-snapshot.test.ts`, `test/gateway-ops.test.ts`, `test/gateway-install-service.test.ts`, additions to `test/slack-adapter.test.ts`.
- **Docs:** `apps/docs/docs/gateway/onboarding.md` (or lifecycle page) — "Operating the gateway". (T9)

---

## Task 1: run-state module + phase wiring

**Files:**
- Create: `packages/cli/src/gateway/run-state.ts`
- Create: `packages/cli/test/gateway-run-state.test.ts`
- Modify: `packages/cli/src/gateway/index.ts` (write site `writePidFile()` @99; after `adapter.start()` @145; `gatewayRunningPid` @181)

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/gateway-run-state.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  writeRunState,
  readGatewayRunStateRaw,
  gatewayLiveRunState,
  installedPlist,
  serviceLabelValid,
} from "../src/gateway/run-state";

const ORIG_HOME = process.env.HOME;
describe("gateway run-state", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-runstate-"));
    process.env.HOME = tmp;
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  it("writeRunState then readRaw round-trips (incl phase)", () => {
    writeRunState({ pid: 4242, startedAt: 1000, phase: "starting", supervised: null });
    const raw = readGatewayRunStateRaw();
    assert.equal(raw?.pid, 4242);
    assert.equal(raw?.phase, "starting");
    assert.equal(raw?.supervised, null);
  });

  it("readRaw returns a STALE entry (dead pid) verbatim; live returns undefined", () => {
    // pid 1 exists but signaling it from a test isn't reliable; use a pid
    // that is almost certainly dead.
    writeRunState({ pid: 2_000_000_000, startedAt: 1, phase: "ready", supervised: null });
    assert.ok(readGatewayRunStateRaw(), "raw still returns the stale row");
    assert.equal(gatewayLiveRunState(), undefined, "live rejects a dead pid");
  });

  it("live returns the row when pid is alive (this process)", () => {
    writeRunState({ pid: process.pid, startedAt: 1, phase: "ready", supervised: null });
    assert.equal(gatewayLiveRunState()?.pid, process.pid);
  });

  it("installedPlist undefined when no plist; serviceLabelValid guards the label", () => {
    assert.equal(installedPlist(), undefined);
    assert.equal(serviceLabelValid("com.pmk.gateway"), true);
    assert.equal(serviceLabelValid("bad label"), false);
    assert.equal(serviceLabelValid("../evil"), false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/gateway-run-state.test.ts`
Expected: FAIL — cannot find module `../src/gateway/run-state`.

- [ ] **Step 3: Implement `run-state.ts`**

```ts
// packages/cli/src/gateway/run-state.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { gatewayDir } from "./config";

export interface GatewayRunState {
  pid: number;
  startedAt: number;
  phase: "starting" | "ready";
  supervised: "launchd" | null;
  serviceLabel?: string;
}

export const SERVICE_LABEL = "com.pmk.gateway";

function runStatePath(): string {
  return path.join(gatewayDir(), "runtime.json");
}

function isRunState(v: unknown): v is GatewayRunState {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as GatewayRunState).pid === "number" &&
    typeof (v as GatewayRunState).startedAt === "number"
  );
}

export function writeRunState(state: GatewayRunState): void {
  const file = runStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
}

export function removeRunState(): void {
  try {
    fs.unlinkSync(runStatePath());
  } catch {
    /* may already be gone */
  }
}

/** The file as-is — may be stale (pid dead). For `status`, never liveness-gated. */
export function readGatewayRunStateRaw(): GatewayRunState | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(runStatePath(), "utf8")) as unknown;
    return isRunState(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Raw + liveness-checked via signal 0. undefined if not actually running. */
export function gatewayLiveRunState(): GatewayRunState | undefined {
  const raw = readGatewayRunStateRaw();
  if (!raw) return undefined;
  try {
    process.kill(raw.pid, 0);
    return raw;
  } catch {
    return undefined;
  }
}

export function serviceLabelValid(label: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(label);
}

function launchAgentPath(label = SERVICE_LABEL): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

/** The LaunchAgent plist exists on disk (installed, may or may not be loaded). */
export function installedPlist(label = SERVICE_LABEL):
  | { label: string; plistPath: string }
  | undefined {
  const plistPath = launchAgentPath(label);
  return fs.existsSync(plistPath) ? { label, plistPath } : undefined;
}

/** The service is loaded in the launchd domain (`launchctl print` succeeds). */
export function loadedService(label = SERVICE_LABEL): boolean {
  if (!serviceLabelValid(label)) return false;
  try {
    execFileSync("launchctl", ["print", `gui/${process.getuid()}/${label}`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/cli && node --import tsx --test test/gateway-run-state.test.ts`
Expected: PASS (4 tests). (`loadedService` is not unit-tested here — it shells to launchctl; covered behaviorally in T6 with a mock.)

- [ ] **Step 5: Wire phase into `runGateway`** — in `src/gateway/index.ts`:
  1. Add imports: `import { writeRunState, removeRunState, readGatewayRunStateRaw, gatewayLiveRunState } from "./run-state";`
  2. Replace the `writePidFile()` call (line ~99) with a starting-phase run-state write:

```ts
  writeRunState({
    pid: process.pid,
    startedAt: Date.now(),
    phase: "starting",
    supervised: process.env.PMK_SERVICE === "launchd" ? "launchd" : null,
    serviceLabel: process.env.PMK_SERVICE_LABEL,
  });
```

  3. After `const info = await adapter.start();` (line ~145) rewrite to `ready`, preserving `startedAt`:

```ts
    const prev = readGatewayRunStateRaw();
    writeRunState({
      pid: process.pid,
      startedAt: prev?.startedAt ?? Date.now(),
      phase: "ready",
      supervised: process.env.PMK_SERVICE === "launchd" ? "launchd" : null,
      serviceLabel: process.env.PMK_SERVICE_LABEL,
    });
```

  4. In the `catch` and shutdown paths, replace `removePidFile()` with `removeRunState()`.
  5. Replace the body of `gatewayRunningPid()` with `return gatewayLiveRunState()?.pid;` and delete the now-unused `writePidFile`/`removePidFile`/`gatewayPidPath` plumbing (keep `gatewayPidPath` import removal). Other callers of `gatewayRunningPid()` are unchanged.

- [ ] **Step 6: Run full suite + commit**

Run: `cd packages/cli && npm test` → green (existing gateway tests still pass; new run-state tests pass).

```bash
git add packages/cli/src/gateway/run-state.ts packages/cli/test/gateway-run-state.test.ts packages/cli/src/gateway/index.ts
git commit -m "feat(gateway): run-state file with phase + launchd discovery"
```

## Task 2: shared health-verdict helper

**Files:**
- Create: `packages/cli/src/gateway/health-verdict.ts`
- Create: `packages/cli/test/gateway-health-verdict.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/gateway-health-verdict.test.ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { heartbeatBand, verdict } from "../src/gateway/health-verdict";

describe("heartbeatBand", () => {
  it("fresh < 30s, aging 30–60s, stale >= 60s", () => {
    assert.equal(heartbeatBand(10_000), "fresh");
    assert.equal(heartbeatBand(45_000), "aging");
    assert.equal(heartbeatBand(60_000), "stale");
    assert.equal(heartbeatBand(undefined), "stale"); // no heartbeat = stale
  });
});

describe("verdict", () => {
  it("down when pid dead or heartbeat stale", () => {
    assert.equal(verdict({ pidAlive: false, heartbeatAge: 1000 }).level, "down");
    assert.equal(verdict({ pidAlive: true, heartbeatAge: 90_000 }).level, "down");
  });
  it("with live inputs: healthy vs degraded", () => {
    assert.equal(
      verdict({ pidAlive: true, heartbeatAge: 5_000, live: { socketState: "connected", flaps: 0 } }).level,
      "healthy",
    );
    assert.equal(
      verdict({ pidAlive: true, heartbeatAge: 5_000, live: { socketState: "reconnecting", flaps: 0 } }).level,
      "degraded",
    );
    assert.equal(
      verdict({ pidAlive: true, heartbeatAge: 5_000, live: { socketState: "connected", flaps: 2 } }).level,
      "degraded",
    );
    assert.equal(
      verdict({ pidAlive: true, heartbeatAge: 45_000, live: { socketState: "connected", flaps: 0 } }).level,
      "degraded", // aging heartbeat
    );
  });
  it("without live inputs (CLI): never healthy — caps at degraded when up", () => {
    const v = verdict({ pidAlive: true, heartbeatAge: 5_000 });
    assert.equal(v.level, "degraded");
    assert.match(v.note, /live socket unknown/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/gateway-health-verdict.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/gateway/health-verdict.ts
import { HEARTBEAT_STALE_MS } from "./heartbeat";
import type { ConnState } from "./socket-health";

const FRESH_MS = 30_000; // < this = fresh; up to HEARTBEAT_STALE_MS = aging; >= = stale

export type HeartbeatBand = "fresh" | "aging" | "stale";
export type VerdictLevel = "healthy" | "degraded" | "down";

export function heartbeatBand(ageMs: number | undefined): HeartbeatBand {
  if (ageMs === undefined || ageMs >= HEARTBEAT_STALE_MS) return "stale";
  if (ageMs < FRESH_MS) return "fresh";
  return "aging";
}

export interface VerdictInput {
  pidAlive: boolean;
  heartbeatAge: number | undefined;
  /** Optional live socket/watchdog inputs — only the daemon (Slack doctor) has them. */
  live?: { socketState: ConnState; flaps: number };
}

export interface Verdict {
  level: VerdictLevel;
  emoji: "🟢" | "🟡" | "🔴";
  note: string;
}

export function verdict(input: VerdictInput): Verdict {
  const band = heartbeatBand(input.heartbeatAge);
  if (!input.pidAlive || band === "stale") {
    return { level: "down", emoji: "🔴", note: "process dead or heartbeat stale" };
  }
  if (input.live) {
    const degraded =
      input.live.socketState !== "connected" || input.live.flaps > 0 || band === "aging";
    return degraded
      ? { level: "degraded", emoji: "🟡", note: "socket/heartbeat degraded" }
      : { level: "healthy", emoji: "🟢", note: "connected" };
  }
  // No live inputs (CLI): can't confirm the socket → never healthy.
  return {
    level: "degraded",
    emoji: "🟡",
    note: "process + heartbeat ok, live socket unknown — see /pmk admin doctor",
  };
}
```

- [ ] **Step 4: Run to verify it passes** → `node --import tsx --test test/gateway-health-verdict.test.ts` PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/health-verdict.ts packages/cli/test/gateway-health-verdict.test.ts
git commit -m "feat(gateway): shared health verdict helper (optional live inputs)"
```

## Task 3: SocketHealth + SocketWatchdog snapshot APIs

**Files:**
- Modify: `packages/cli/src/gateway/socket-health.ts` (add `snapshot`)
- Modify: `packages/cli/src/gateway/slack/socket-watchdog.ts` (counters + `snapshot`)
- Create: `packages/cli/test/gateway-socket-snapshot.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/gateway-socket-snapshot.test.ts
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
```

- [ ] **Step 2: Run to verify it fails** → `node --import tsx --test test/gateway-socket-snapshot.test.ts` FAIL (`snapshot` not a function).

- [ ] **Step 3: Implement**

In `socket-health.ts`, add a public method (the fields `state`, `pongTimeouts`, `stateSince` are private; this is the read API) after `assess`:

```ts
  /** Read-only health snapshot for `/pmk admin doctor`. Never mutates. */
  snapshot(nowMs: number): {
    state: ConnState;
    pongTimeoutsInWindow: number;
    unstableMs: number;
  } {
    const inWindow = this.pongTimeouts.filter(
      (t) => nowMs - t <= PONG_TIMEOUT_WINDOW_MS,
    ).length;
    return {
      state: this.state,
      pongTimeoutsInWindow: inWindow,
      unstableMs: this.state === "connected" ? 0 : nowMs - this.stateSince,
    };
  }
```

In `socket-watchdog.ts`, add two counters and bump them where reconnects happen, then a snapshot. Add fields near `failedReconnects`:

```ts
  private flaps = 0;        // times the socket went unhealthy and we reacted
  private reconnects = 0;   // reconnect attempts started
```

In the place a reconnect is started (the `tick()` branch that calls `this.deps.reconnect()` — guarded by `if (this.inFlight) return;`), increment before calling:

```ts
    this.flaps += 1;
    this.reconnects += 1;
```

Add a public read after the constructor:

```ts
  /** Read-only watchdog snapshot for `/pmk admin doctor`. */
  snapshot(): { flaps: number; reconnects: number; confirmedFailures: number } {
    return {
      flaps: this.flaps,
      reconnects: this.reconnects,
      confirmedFailures: this.failedReconnects,
    };
  }
```

(Read `socket-watchdog.ts` first to place the `flaps++/reconnects++` at the exact reconnect-start site — search for `this.deps.reconnect(`.)

- [ ] **Step 4: Run to verify it passes** → `node --import tsx --test test/gateway-socket-snapshot.test.ts` PASS; `npm test` green (existing watchdog tests unaffected — counters are additive).
- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/socket-health.ts packages/cli/src/gateway/slack/socket-watchdog.ts packages/cli/test/gateway-socket-snapshot.test.ts
git commit -m "feat(gateway): SocketHealth/SocketWatchdog public snapshot APIs"
```

## Task 4: enhanced `pmk gateway status` (persisted, no secret resolution)

**Files:**
- Modify: `packages/cli/src/gateway/heartbeat.ts` (export `lastHeartbeatAt`)
- Modify: `packages/cli/src/commands/gateway/ops.ts` (`statusCmd` rewrite)
- Create: `packages/cli/test/gateway-ops.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/gateway-ops.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildStatusReport } from "../src/commands/gateway/ops";
import { writeRunState } from "../src/gateway/run-state";

const ORIG_HOME = process.env.HOME;
describe("gateway status (persisted)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-ops-"));
    process.env.HOME = tmp;
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  it("dead pid → 🔴 down; renders persisted fields; never executes a {cmd} secret", () => {
    // gateway.json with a {cmd} that MUST NOT run (writes a sentinel file).
    const sentinel = path.join(tmp, "RAN");
    fs.mkdirSync(path.join(tmp, ".pmk"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".pmk", "gateway.json"),
      JSON.stringify({
        version: 1, admins: [], blocklist: [],
        audience: { default: "biz", users: {}, channels: {} },
        escalation: { default: [], repos: {} },
        slack: { appToken: { cmd: `touch ${sentinel}` }, botToken: "xoxb-x" },
      }),
    );
    writeRunState({ pid: 2_000_000_000, startedAt: 1, phase: "ready", supervised: null });
    const r = buildStatusReport(Date.now());
    assert.equal(r.level, "down"); // dead pid
    assert.equal(fs.existsSync(sentinel), false, "status must NOT run the {cmd} secret");
  });

  it("alive pid + fresh heartbeat → caps at 🟡 (CLI has no live socket)", () => {
    writeRunState({ pid: process.pid, startedAt: Date.now() - 5000, phase: "ready", supervised: null });
    // write a fresh heartbeat file
    fs.mkdirSync(path.join(tmp, ".pmk", "gateway"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".pmk", "gateway", "heartbeat"), String(Date.now()));
    const r = buildStatusReport(Date.now());
    assert.equal(r.level, "degraded"); // 🟡, never 🟢 from CLI
    assert.match(r.text, /live socket unknown/);
  });
});
```

- [ ] **Step 2: Run to verify it fails** → FAIL (`buildStatusReport` not exported).

- [ ] **Step 3: Implement**
  1. In `heartbeat.ts`, export a reader (the file path helper `gatewayHeartbeatPath` + `readEpochFile` already exist internally):

```ts
export function lastHeartbeatAt(): number | undefined {
  return readEpochFile(gatewayHeartbeatPath());
}
```

  2. In `ops.ts`, add `buildStatusReport` (pure, testable) and rewrite `statusCmd` to print it. Imports: `readGatewayRunStateRaw` from `../../gateway/run-state`, `loadRawGatewayConfig` from `../../gateway/config`, `lastHeartbeatAt` from `../../gateway/heartbeat`, `readGatewayEvents` from `../../gateway/events`, `verdict` from `../../gateway/health-verdict`.

```ts
export function buildStatusReport(now: number): { level: string; text: string } {
  const run = readGatewayRunStateRaw();
  const pidAlive = run ? isPidAlive(run.pid) : false;
  const hbAt = lastHeartbeatAt();
  const heartbeatAge = hbAt === undefined ? undefined : now - hbAt;
  const v = verdict({ pidAlive, heartbeatAge }); // no live → caps at 🟡
  // NOTE: loadRawGatewayConfig — must NEVER resolve a {cmd}/{env} secret here.
  const cfg = loadRawGatewayConfig();
  const events = readGatewayEvents({ sinceMs: now - 30 * 60_000 });
  const turns = events.filter((e) => (e as { type: string }).type === "turn.processed").length;
  const lastOffline = [...events].reverse().find(
    (e) => (e as { type: string }).type === "gateway.offline",
  ) as { reason?: string } | undefined;
  const lines = [
    `${v.emoji} ${v.level} — ${v.note}`,
    `  running:   ${pidAlive ? `yes (pid ${run!.pid})` : "no"}`,
    `  supervised: ${run?.supervised ?? "no"}${run?.serviceLabel ? ` (${run.serviceLabel})` : ""}`,
    `  heartbeat: ${heartbeatAge === undefined ? "none" : `${Math.round(heartbeatAge / 1000)}s ago`}`,
    `  uptime:    ${run && pidAlive ? `${Math.round((now - run.startedAt) / 1000)}s` : "—"}`,
    `  turns/30m: ${turns}`,
    `  last offline reason: ${lastOffline?.reason ?? "—"}`,
    `  mra workspace: ${cfg.mraWorkspace ?? "(not configured)"}`,
    `  live socket: use \`/pmk admin doctor\` in Slack`,
  ];
  return { level: v.level, text: lines.join("\n") };
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
```

  Rewrite `statusCmd()` body to: `const r = buildStatusReport(Date.now()); println(chalk.bold("\npmk gateway status")); println(r.text);` (drop the old `loadGatewayConfig()` / `hasValidSlackTokens` lines — auth belongs in `doctor`).

- [ ] **Step 4: Run to verify it passes** → `node --import tsx --test test/gateway-ops.test.ts` PASS; `npm test` green.
- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/heartbeat.ts packages/cli/src/commands/gateway/ops.ts packages/cli/test/gateway-ops.test.ts
git commit -m "feat(gateway): status reports persisted health (verdict, no secret resolution)"
```

## Task 5: `pmk gateway stop`

**Files:**
- Modify: `packages/cli/src/commands/gateway/ops.ts` (`stopCmd`)
- Modify: `packages/cli/src/commands/gateway/index.ts` (`stop` case)
- Modify: `packages/cli/test/gateway-ops.test.ts`

Inject a `deps` object (matching the watchdog-deps pattern) so launchctl/kill are testable.

- [ ] **Step 1: Write the failing test** (append to `gateway-ops.test.ts`)

```ts
import { stopCmdImpl, type OpsDeps } from "../src/commands/gateway/ops";

describe("gateway stop", () => {
  // … HOME tmp setup as above …
  function deps(over: Partial<OpsDeps> = {}): OpsDeps & { calls: string[][] } {
    const calls: string[][] = [];
    return {
      calls,
      execFile: (f, a) => { calls.push([f, ...a]); },
      kill: () => {},
      now: () => 1000,
      sleep: async () => {},
      ...over,
    };
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
    assert.deepEqual(d.calls[0], ["launchctl", "bootout", `gui/${process.getuid()}/com.pmk.gateway`]);
  });

  it("standalone live → SIGTERM then poll to exit", async () => {
    writeRunState({ pid: process.pid, startedAt: 1, phase: "ready", supervised: null });
    let killed: [number, string | number] | undefined;
    let alive = true;
    const d = deps({ kill: (p, sig) => { if (sig === "SIGTERM") { killed = [p, sig]; alive = false; } else if (!alive) throw new Error("dead"); } });
    const out = await stopCmdImpl(d);
    assert.equal(killed?.[1], "SIGTERM");
    assert.match(out, /stopped/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails** → FAIL (`stopCmdImpl`/`OpsDeps` missing).

- [ ] **Step 3: Implement** — in `ops.ts`:

```ts
import { execFile as nodeExecFile } from "node:child_process";
import {
  gatewayLiveRunState, installedPlist, loadedService, serviceLabelValid, SERVICE_LABEL,
} from "../../gateway/run-state";

export interface OpsDeps {
  execFile: (file: string, args: string[]) => void;       // throws on failure
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}
const realDeps: OpsDeps = {
  execFile: (f, a) => { require("node:child_process").execFileSync(f, a, { stdio: "ignore" }); },
  kill: (p, s) => process.kill(p, s),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

function launchctlTarget(): { label: string } | undefined {
  const live = gatewayLiveRunState();
  if (live?.supervised === "launchd" && live.serviceLabel && serviceLabelValid(live.serviceLabel)) {
    return { label: live.serviceLabel };
  }
  if (loadedService(SERVICE_LABEL) || installedPlist(SERVICE_LABEL)) return { label: SERVICE_LABEL };
  return undefined;
}

export async function stopCmdImpl(d: OpsDeps = realDeps): Promise<string> {
  const live = gatewayLiveRunState();
  const lc = launchctlTarget();
  if (lc && (loadedService(lc.label) || live?.supervised === "launchd")) {
    d.execFile("launchctl", ["bootout", `gui/${process.getuid()}/${lc.label}`]);
    return `stopped launchd service ${lc.label}`;
  }
  if (!live) return "gateway is not running.";
  d.kill(live.pid, "SIGTERM");
  for (let i = 0; i < 30; i++) {
    await d.sleep(1000);
    try { d.kill(live.pid, 0); } catch { return "gateway stopped (graceful)."; }
  }
  return "gateway still running after 30s — check ~/.pmk/logs/gateway.err.log";
}

export async function stopCmd(): Promise<void> { println(await stopCmdImpl()); }
```

  Add to `commands/gateway/index.ts`: import `stopCmd`; `case "stop": return await stopCmd();`.

- [ ] **Step 4: Run to verify it passes** → `node --import tsx --test test/gateway-ops.test.ts` PASS; `npm test` green.
- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/gateway/ops.ts packages/cli/src/commands/gateway/index.ts packages/cli/test/gateway-ops.test.ts
git commit -m "feat(gateway): pmk gateway stop (launchd bootout / standalone SIGTERM)"
```

## Task 6: `pmk gateway restart`

**Files:**
- Modify: `packages/cli/src/commands/gateway/ops.ts` (`restartCmd`), `commands/gateway/index.ts` (`restart` case), `test/gateway-ops.test.ts`

Reuses `OpsDeps` + adds `spawnDetached` + `readReady`. Decision: `loadedService` → `kickstart -k`; `installedPlist` unloaded → `bootstrap`; standalone → stop + detached spawn + poll for `phase:"ready"`.

- [ ] **Step 1: Write the failing test**

```ts
import { restartCmdImpl } from "../src/commands/gateway/ops";

describe("gateway restart", () => {
  // HOME tmp setup …
  it("plist installed but NOT loaded → launchctl bootstrap (not kickstart)", async () => {
    // create the plist so installedPlist() is true; loadedService() mocked false
    fs.mkdirSync(path.join(process.env.HOME!, "Library", "LaunchAgents"), { recursive: true });
    fs.writeFileSync(path.join(process.env.HOME!, "Library", "LaunchAgents", "com.pmk.gateway.plist"), "<plist/>");
    const calls: string[][] = [];
    await restartCmdImpl({
      execFile: (f, a) => calls.push([f, ...a]),
      kill: () => {}, now: () => 0, sleep: async () => {},
      isLoaded: () => false,                 // unloaded
      spawnDetached: () => 999,
      readReady: () => undefined,
    } as any);
    assert.equal(calls[0][1], "bootstrap");   // NOT kickstart
  });

  it("loaded service → kickstart -k", async () => {
    const calls: string[][] = [];
    await restartCmdImpl({
      execFile: (f, a) => calls.push([f, ...a]),
      kill: () => {}, now: () => 0, sleep: async () => {},
      isLoaded: () => true, spawnDetached: () => 0, readReady: () => undefined,
    } as any);
    assert.deepEqual(calls[0].slice(1, 3), ["kickstart", "-k"]);
  });

  it("standalone → stop + detached spawn; success ONLY on phase ready", async () => {
    writeRunState({ pid: process.pid, startedAt: 1, phase: "ready", supervised: null });
    let spawned = false; let polls = 0;
    const out = await restartCmdImpl({
      execFile: () => {}, kill: () => { throw new Error("dead"); }, // already gone
      now: () => 0, sleep: async () => {},
      isLoaded: () => false, spawnDetached: () => { spawned = true; return 777; },
      readReady: () => (++polls >= 2 ? { pid: 777, phase: "ready" } : { pid: 777, phase: "starting" }),
    } as any);
    assert.equal(spawned, true);
    assert.match(out, /restarted/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails** → FAIL.

- [ ] **Step 3: Implement** — extend `OpsDeps` with the restart hooks and add `restartCmdImpl`:

```ts
export interface RestartDeps extends OpsDeps {
  isLoaded: (label: string) => boolean;          // wraps loadedService
  spawnDetached: () => number;                    // spawns `gateway start` detached, returns child pid
  readReady: () => { pid: number; phase: string } | undefined; // reads run-state raw
}

export async function restartCmdImpl(d: RestartDeps): Promise<string> {
  const live = gatewayLiveRunState();
  const installed = installedPlist(SERVICE_LABEL);
  const uid = process.getuid();
  if (d.isLoaded(SERVICE_LABEL) || live?.supervised === "launchd") {
    d.execFile("launchctl", ["kickstart", "-k", `gui/${uid}/${SERVICE_LABEL}`]);
    return `restarted launchd service ${SERVICE_LABEL}`;
  }
  if (installed) {
    d.execFile("launchctl", ["bootstrap", `gui/${uid}`, installed.plistPath]);
    return `bootstrapped launchd service ${SERVICE_LABEL}`;
  }
  // standalone: stop (if live) then detached respawn, poll for ready
  if (live) {
    try { d.kill(live.pid, "SIGTERM"); } catch { /* already gone */ }
    for (let i = 0; i < 30; i++) { await d.sleep(1000); try { d.kill(live.pid, 0); } catch { break; } }
  }
  const childPid = d.spawnDetached();
  for (let i = 0; i < 15; i++) {
    await d.sleep(1000);
    const r = d.readReady();
    if (r && r.pid === childPid && r.phase === "ready") return `gateway restarted (pid ${childPid}).`;
  }
  return "start may have failed — see ~/.pmk/logs/gateway.err.log";
}
```

  The real `spawnDetached` (used by `restartCmd()` wrapper): open the two log files (`fs.openSync(path.join(gatewayDir(), "..", "logs", "gateway.out.log"), "a")` etc.; ensure `~/.pmk/logs` exists), then `const c = spawn(process.execPath, [path.join(__dirname, "../../index.js"), "gateway", "start"], { detached: true, stdio: ["ignore", outFd, errFd] }); c.unref(); return c.pid!;`. The real `readReady` = `readGatewayRunStateRaw`. Wire `restartCmd()` to build `RestartDeps` from `realDeps` + `{ isLoaded: loadedService, spawnDetached, readReady: readGatewayRunStateRaw }`.

  Add to `commands/gateway/index.ts`: `case "restart": return await restartCmd();`.

- [ ] **Step 4: Run + Step 5: Commit**

```bash
git add packages/cli/src/commands/gateway/ops.ts packages/cli/src/commands/gateway/index.ts packages/cli/test/gateway-ops.test.ts
git commit -m "feat(gateway): pmk gateway restart (kickstart/bootstrap/standalone ready-poll)"
```

## Task 7: Slack `/pmk admin doctor` (live, provider read at command time)

**Files:**
- Modify: `packages/cli/src/gateway/slack/admin.ts` (`adminDoctor` + `doctor` case + `AdminSlashArgs.getRuntimeHealthSnapshot`)
- Modify: `packages/cli/src/gateway/slack/slash-command.ts` (thread the provider through)
- Modify: `packages/cli/src/gateway/slack/index.ts` (build the provider closure)
- Modify: `packages/cli/test/slack-adapter.test.ts` (or new `test/gateway-admin-doctor.test.ts`)

- [ ] **Step 1: Write the failing test** (new file `test/gateway-admin-doctor.test.ts`)

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleAdminSlash } from "../src/gateway/slack/admin";
import { writeRunState } from "../src/gateway/run-state";

const ORIG_HOME = process.env.HOME;
describe("/pmk admin doctor", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-doc-")); process.env.HOME = tmp;
    writeRunState({ pid: process.pid, startedAt: Date.now() - 5000, phase: "ready", supervised: null });
    fs.mkdirSync(path.join(tmp, ".pmk", "gateway"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".pmk", "gateway", "heartbeat"), String(Date.now()));
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (ORIG_HOME) process.env.HOME = ORIG_HOME; });

  function call(snap: any) {
    return handleAdminSlash({
      actor: "U-ADMIN", isAdmin: true, sub: "doctor", rest: [],
      web: {} as any, config: { admins: ["U-ADMIN"] } as any,
      getRuntimeHealthSnapshot: () => snap(),
    } as any);
  }

  it("reads the provider at COMMAND time (not construction)", async () => {
    let state = "connected";
    const snap = () => ({ socket: { state, pongTimeoutsInWindow: 0, unstableMs: 0 }, watchdog: { flaps: 0, reconnects: 0, confirmedFailures: 0 }, startedAt: Date.now() - 5000 });
    const r1 = await call(snap);
    assert.match(r1.text, /🟢|healthy/);
    state = "reconnecting"; // change between calls
    const r2 = await call(snap);
    assert.match(r2.text, /🟡|degraded/);  // proves command-time read
  });

  it("non-admin denied", async () => {
    const r = await handleAdminSlash({ actor: "U-X", isAdmin: false, sub: "doctor", rest: [], web: {} as any, config: { admins: [] } as any } as any);
    assert.match(r.text, /not author[i|z]/i);
  });
});
```

(Adjust the `handleAdminSlash` arg shape to the real `AdminSlashArgs` — read `admin.ts:48-103` first; the admin gate may live in the dispatcher, in which case pass the fields it expects.)

- [ ] **Step 2: Run to verify it fails** → FAIL (`doctor` sub unknown / `getRuntimeHealthSnapshot` not in args).

- [ ] **Step 3: Implement**
  1. `admin.ts`: add to `AdminSlashArgs`: `getRuntimeHealthSnapshot?: () => RuntimeHealthSnapshot;` and the type:

```ts
export interface RuntimeHealthSnapshot {
  socket?: { state: ConnState; pongTimeoutsInWindow: number; unstableMs: number };
  watchdog?: { flaps: number; reconnects: number; confirmedFailures: number };
  startedAt: number;
}
```

  Add `case "doctor": return adminDoctor(args);` to the dispatcher (`handleAdminSlash`), and:

```ts
function adminDoctor(args: AdminSlashArgs): AdminSlashResult {
  const now = Date.now();
  const snap = args.getRuntimeHealthSnapshot?.();
  const hbAt = lastHeartbeatAt();
  const heartbeatAge = hbAt === undefined ? undefined : now - hbAt;
  const live = snap?.socket ? { socketState: snap.socket.state, flaps: snap.watchdog?.flaps ?? 0 } : undefined;
  const v = verdict({ pidAlive: true, heartbeatAge, live }); // running daemon → pid alive
  const events = readGatewayEvents({ sinceMs: now - 30 * 60_000 });
  const turns = events.filter((e) => (e as { type: string }).type === "turn.processed").length;
  const lines = [
    `${v.emoji} *gateway ${v.level}* — ${v.note}`,
    `• socket: ${snap?.socket ? `${snap.socket.state} (pong-timeouts ${snap.socket.pongTimeoutsInWindow}, unstable ${Math.round(snap.socket.unstableMs/1000)}s)` : "unknown"}`,
    `• watchdog: ${snap?.watchdog ? `${snap.watchdog.flaps} flaps, ${snap.watchdog.confirmedFailures} confirmed-fail` : "unknown"}`,
    `• heartbeat: ${heartbeatAge === undefined ? "none" : `${Math.round(heartbeatAge/1000)}s ago`}`,
    `• uptime: ${snap ? `${Math.round((now - snap.startedAt)/1000)}s` : "—"}`,
    `• turns/30m: ${turns}`,
  ];
  logAdmin(args.actor, "doctor", true);
  return { text: lines.join("\n") };
}
```

  Imports in `admin.ts`: `verdict` from `../health-verdict`, `lastHeartbeatAt` from `../heartbeat`, `readGatewayEvents` from `../events`, `type ConnState` from `../socket-health`.

  2. `slash-command.ts`: add `getRuntimeHealthSnapshot?` to `SlashCommandHandlerOptions`, store it, and pass it in the `handleAdminSlash({ ... })` call (~line 203).
  3. `slack/index.ts`: when constructing `new SlashCommandHandler({...})` (~line 207), add `getRuntimeHealthSnapshot: () => ({ socket: this.health.snapshot(Date.now()), watchdog: this.watchdog?.snapshot(), startedAt: this.startedAt })`. Add `private readonly startedAt = Date.now();` field if not present.

- [ ] **Step 4: Run + Step 5: Commit**

```bash
git add packages/cli/src/gateway/slack/admin.ts packages/cli/src/gateway/slack/slash-command.ts packages/cli/src/gateway/slack/index.ts packages/cli/test/gateway-admin-doctor.test.ts
git commit -m "feat(gateway): /pmk admin doctor live runtime health (command-time provider)"
```

## Task 8: `pmk gateway install-service` (launchd)

**Files:**
- Create: `packages/cli/src/commands/gateway/service.ts`
- Modify: `packages/cli/src/commands/gateway/index.ts` (`install-service` case)
- Create: `packages/cli/test/gateway-install-service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildPlist, envSecretWarnings } from "../src/commands/gateway/service";

describe("install-service plist", () => {
  it("plist has Label/KeepAlive/PMK_SERVICE env, abs paths, NO secret", () => {
    const xml = buildPlist({ nodePath: "/usr/bin/node", distEntry: "/abs/dist/index.js", home: "/Users/x", workingDir: "/ws" });
    assert.match(xml, /<key>Label<\/key>\s*<string>com\.pmk\.gateway<\/string>/);
    assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.match(xml, /PMK_SERVICE<\/key>\s*<string>launchd<\/string>/);
    assert.match(xml, /\/abs\/dist\/index\.js/);
    assert.doesNotMatch(xml, /xapp-|xoxb-|sk-ant-/); // never a secret
  });

  it("warns when a raw secret source is {env} (won't resolve under launchd)", () => {
    const warns = envSecretWarnings({
      slack: { appToken: { env: "MY_APP" }, botToken: "xoxb-x" }, apiKey: { cmd: "op read x" },
    } as any);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /MY_APP/);
  });
});
```

- [ ] **Step 2: Run to verify it fails** → FAIL.

- [ ] **Step 3: Implement `service.ts`**

```ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { println } from "../../io";
import { loadRawGatewayConfig } from "../../gateway/config";
import { SERVICE_LABEL, installedPlist } from "../../gateway/run-state";
import type { RawGatewayConfig } from "../../gateway/config";

export function buildPlist(o: { nodePath: string; distEntry: string; home: string; workingDir: string }): string {
  const out = path.join(o.home, ".pmk", "logs", "gateway.out.log");
  const err = path.join(o.home, ".pmk", "logs", "gateway.err.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${o.nodePath}</string><string>${o.distEntry}</string><string>gateway</string><string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>WorkingDirectory</key><string>${o.workingDir}</string>
  <key>StandardOutPath</key><string>${out}</string>
  <key>StandardErrorPath</key><string>${err}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PMK_SERVICE</key><string>launchd</string>
    <key>PMK_SERVICE_LABEL</key><string>${SERVICE_LABEL}</string>
    <key>HOME</key><string>${o.home}</string>
    <key>PATH</key><string>${process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"}</string>
  </dict>
</dict></plist>
`;
}

/** Raw secret sources that are {env} won't resolve under launchd's minimal env. */
export function envSecretWarnings(cfg: Pick<RawGatewayConfig, "slack" | "apiKey">): string[] {
  const warns: string[] = [];
  const check = (name: string, v: unknown) => {
    if (v && typeof v === "object" && "env" in (v as object)) {
      warns.push(`${name} is an {env:${(v as { env: string }).env}} reference — the LaunchAgent has no such env; use a {cmd} ref / literal, or add it to the plist yourself.`);
    }
  };
  check("slack.appToken", cfg.slack?.appToken);
  check("slack.botToken", cfg.slack?.botToken);
  check("apiKey", cfg.apiKey);
  return warns;
}

export function installServiceCmd(opts: { load?: boolean; uninstall?: boolean; force?: boolean } = {}): void {
  if (process.platform !== "darwin") { println("install-service is macOS-only (launchd)."); return; }
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  const uid = process.getuid!();
  if (opts.uninstall) {
    try { execFileSync("launchctl", ["bootout", `gui/${uid}/${SERVICE_LABEL}`], { stdio: "ignore" }); } catch { /* not loaded */ }
    try { fs.unlinkSync(plistPath); } catch { /* gone */ }
    println(`uninstalled ${SERVICE_LABEL}.`); return;
  }
  if (installedPlist() && !opts.force) { println(`${plistPath} already exists. Re-run with --force to overwrite.`); return; }
  for (const w of envSecretWarnings(loadRawGatewayConfig())) println(`  ⚠️  ${w}`);
  const cfg = loadRawGatewayConfig();
  const workingDir = cfg.mraWorkspace && fs.existsSync(path.join(cfg.mraWorkspace, ".collab", "repos.json"))
    ? cfg.mraWorkspace
    : (println("  ⚠️  mraWorkspace not set/valid — mra-ask falls back to cwd-walk from the install dir."), process.cwd());
  const distEntry = path.resolve(__dirname, "../../index.js");
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.mkdirSync(path.join(os.homedir(), ".pmk", "logs"), { recursive: true });
  fs.writeFileSync(plistPath, buildPlist({ nodePath: process.execPath, distEntry, home: os.homedir(), workingDir }), "utf8");
  println(`wrote ${plistPath}`);
  if (opts.load) {
    execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { stdio: "inherit" });
    execFileSync("launchctl", ["enable", `gui/${uid}/${SERVICE_LABEL}`], { stdio: "inherit" });
    println("loaded.");
  } else {
    println(`Next: launchctl bootstrap gui/${uid} ${plistPath} && launchctl enable gui/${uid}/${SERVICE_LABEL}`);
  }
}
```

  Add to `commands/gateway/index.ts`: `case "install-service": return installServiceCmd(parseInstallFlags(rest));` (parse `--load`/`--uninstall`/`--force` from `rest`).

- [ ] **Step 4: Run + Step 5: Commit**

```bash
git add packages/cli/src/commands/gateway/service.ts packages/cli/src/commands/gateway/index.ts packages/cli/test/gateway-install-service.test.ts
git commit -m "feat(gateway): pmk gateway install-service (launchd, no secrets, {env} warning)"
```

## Task 9: docs — "Operating the gateway"

**Files:**
- Modify: `apps/docs/docs/gateway/onboarding.md` (or the lifecycle page)

- [ ] **Step 1:** Add an "Operating the gateway" section: `pmk gateway start` / `stop` / `restart` (standalone vs launchd auto-detect), `pmk gateway status` (persisted 🟢/🟡/🔴, works when down) vs Slack `/pmk admin doctor` (live socket/watchdog), and `pmk gateway install-service [--load]` for always-on (KeepAlive respawn; pairs with the v0.19 loud-exit). Note the `{env}`-secret caveat under launchd. Keep the page's voice; use valid relative links.
- [ ] **Step 2: Commit**

```bash
git add apps/docs/docs/gateway/onboarding.md
git commit -m "docs(gateway): operating the gateway — stop/restart/doctor/install-service"
```

## Final verification (after all tasks)

```bash
cd packages/cli && npm test && npx tsc -p tsconfig.json --noEmit && npm run build
```
Expected: all green, build OK, no new `npm audit` advisories.
