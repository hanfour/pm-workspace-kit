# Gateway keep-awake hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a long-running `pmk gateway start` survive macOS App-Nap/sleep throttling (in-process power assertion) and self-heal a wedged Socket-Mode connection (watchdog: detect → in-process reconnect → loud, alerting exit), so the gateway can never again silently fail.

**Architecture:** Three small new units — a pure `SocketHealth` tracker, a `keep-awake` caffeinate wrapper, a pong-tap `Logger` — plus a `SocketWatchdog` state machine, wired into the existing `SlackAdapter` (`runGateway` owns keep-awake). The watchdog reuses the `PresenceBroadcaster` for its loud-exit offline event + admin alert.

**Tech Stack:** TypeScript (Node ESM, `node:test` via `tsx`), `@slack/socket-mode`, `@slack/logger`, `@slack/web-api`.

Spec: `docs/superpowers/specs/2026-06-03-gateway-keepawake-hardening-design.md`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `packages/cli/src/gateway/socket-health.ts` (new) | Pure `SocketHealth` tracker: pong-timeout window + conn-state machine; `assess`, `reset`, `lastStableConnectedSince`. |
| `packages/cli/src/gateway/keep-awake.ts` (new) | macOS `caffeinate` power assertion bound to the gateway pid; no-op elsewhere. |
| `packages/cli/src/gateway/slack/socket-logger.ts` (new) | `Logger` that taps pong/ping-timeout WARN lines → a callback, forwards all logs. |
| `packages/cli/src/gateway/slack/socket-watchdog.ts` (new) | `SocketWatchdog` state machine + timer: escalating recovery (reconnect → loud exit). Owns the watchdog constants. |
| `packages/cli/src/gateway/slack/presence.ts` (modify) | Add `watchdogTerminate(...)`: offline event (`broadcast:false`) + time-boxed admin DMs. |
| `packages/cli/src/gateway/slack/index.ts` (modify) | Inject pong-tap logger into `SocketModeClient`; register the 5 conn-state listeners → health; construct + start/stop the watchdog. |
| `packages/cli/src/gateway/index.ts` (modify) | `startKeepAwake()` near start; `stop()` in shutdown + start-error paths. |
| `packages/cli/test/socket-health.test.ts` (new) | Unit B tests. |
| `packages/cli/test/keep-awake.test.ts` (new) | Unit A tests. |
| `packages/cli/test/socket-logger.test.ts` (new) | Unit C tests. |
| `packages/cli/test/socket-watchdog.test.ts` (new) | Watchdog state-machine tests. |

Test runner: `cd packages/cli && node --import tsx --test test/<file>.test.ts` for a single file; `npm test` for the full suite (typecheck + all).

Constants live with their unit: window/threshold/unstable in `socket-health.ts`; the watchdog timing constants (`REUNHEALTHY_ATTEMPTS`, `STABLE_CONNECTED_RESET_MS`, `WATCHDOG_RECONNECT_TIMEOUT_MS`, `WATCHDOG_ALERT_TIMEOUT_MS`, `WATCHDOG_INTERVAL_MS`) in `socket-watchdog.ts`; the default caffeinate flags in `keep-awake.ts`.

---

## Task 1: `SocketHealth` tracker (pure)

**Files:**
- Create: `packages/cli/src/gateway/socket-health.ts`
- Test: `packages/cli/test/socket-health.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/socket-health.test.ts`:

```ts
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
    // 4 minutes later the old three have aged out of the window
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
    // connected anchor preserved → stable-since is the connected time
    assert.equal(h.lastStableConnectedSince(14_000), 10_000);
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
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd packages/cli && node --import tsx --test test/socket-health.test.ts`
Expected: FAIL — `Cannot find module '../src/gateway/socket-health'`.

- [ ] **Step 3: Implement `socket-health.ts`**

Create `packages/cli/src/gateway/socket-health.ts`:

```ts
/**
 * Pure health tracker for the Slack Socket-Mode connection. No I/O, no
 * timers, no clock of its own — every method takes `nowMs`. Fed by the
 * pong-tap logger (Unit C) and the adapter's conn-state listeners; read
 * by the SocketWatchdog.
 */

export type ConnState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnecting"
  | "disconnected";

/** Rolling window for counting pong-timeouts. */
export const PONG_TIMEOUT_WINDOW_MS = 60_000;
/** Pong-timeouts within the window that flip the verdict to unhealthy. */
export const PONG_TIMEOUT_THRESHOLD = 3;
/** Max time not-`connected` before the connection is judged unhealthy. */
export const UNSTABLE_CONN_LIMIT_MS = 60_000;

export class SocketHealth {
  private pongTimeouts: number[] = [];
  private state: ConnState = "connecting";
  private stateSince: number;
  private lastPongTimeoutAt: number | null = null;

  constructor(startNowMs: number) {
    this.stateSince = startNowMs;
  }

  recordPongTimeout(nowMs: number): void {
    this.pongTimeouts.push(nowMs);
    this.lastPongTimeoutAt = nowMs;
    this.prune(nowMs);
  }

  recordConnState(state: ConnState, nowMs: number): void {
    if (state !== this.state) {
      this.state = state;
      this.stateSince = nowMs;
    }
  }

  assess(nowMs: number): "healthy" | "unhealthy" {
    this.prune(nowMs);
    if (this.pongTimeouts.length >= PONG_TIMEOUT_THRESHOLD) return "unhealthy";
    if (this.state !== "connected" && nowMs - this.stateSince > UNSTABLE_CONN_LIMIT_MS) {
      return "unhealthy";
    }
    return "healthy";
  }

  /**
   * Clear ONLY the pong-timeout evidence (so the flood window restarts
   * fresh after a forced reconnect). The conn-state machine is
   * event-driven and is deliberately NOT touched — right after a
   * successful reconnect it already holds the fresh `connected`-since
   * anchor that `lastStableConnectedSince` needs.
   */
  reset(_nowMs: number): void {
    this.pongTimeouts = [];
    this.lastPongTimeoutAt = null;
  }

  /**
   * `null` iff not currently `connected`. When connected, the later of
   * {entered-connected, most-recent pong-timeout}: a non-connected state
   * breaks the stretch (null); a pong-timeout while connected merely
   * restarts the stable clock from that instant.
   */
  lastStableConnectedSince(_nowMs: number): number | null {
    if (this.state !== "connected") return null;
    return this.lastPongTimeoutAt !== null
      ? Math.max(this.stateSince, this.lastPongTimeoutAt)
      : this.stateSince;
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - PONG_TIMEOUT_WINDOW_MS;
    if (this.pongTimeouts.length > 0 && this.pongTimeouts[0] < cutoff) {
      this.pongTimeouts = this.pongTimeouts.filter((t) => t >= cutoff);
    }
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd packages/cli && node --import tsx --test test/socket-health.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/socket-health.ts packages/cli/test/socket-health.test.ts
git commit -m "feat(gateway): SocketHealth tracker for keep-awake watchdog"
```

---

## Task 2: `keep-awake` caffeinate wrapper + wire into runGateway

**Files:**
- Create: `packages/cli/src/gateway/keep-awake.ts`
- Test: `packages/cli/test/keep-awake.test.ts`
- Modify: `packages/cli/src/gateway/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/keep-awake.test.ts`:

```ts
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
    h.stop(); // must not throw
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
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd packages/cli && node --import tsx --test test/keep-awake.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `keep-awake.ts`**

Create `packages/cli/src/gateway/keep-awake.ts`:

```ts
/**
 * macOS keep-awake: hold a `caffeinate` power assertion bound to the
 * gateway's own pid (`-w <pid>`), so a backgrounded daemon can't be
 * App-Nap/idle-sleep throttled into starving Slack's Socket-Mode
 * ping/pong. No-op on every non-macOS platform. Best-effort: a spawn
 * failure must never block the gateway from starting.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

/**
 * Default flags: `-i` (prevent idle system sleep) + `-s` (prevent system
 * sleep on AC). Deliberately NOT `-dimsu` — `-d` holds the display awake
 * (battery/screen cost). `-dimsu` is the verified-working escalation,
 * available via PMK_GATEWAY_CAFFEINATE_FLAGS, not the default.
 */
export const DEFAULT_CAFFEINATE_FLAGS = "-is";

export interface KeepAwakeDeps {
  platform?: NodeJS.Platform;
  pid?: number;
  spawn?: typeof nodeSpawn;
  /** Override flags string; defaults to PMK_GATEWAY_CAFFEINATE_FLAGS env or DEFAULT. */
  flagsEnv?: string | undefined;
  onLog?: (msg: string) => void;
}

export interface KeepAwakeHandle {
  stop: () => void;
}

export function startKeepAwake(deps: KeepAwakeDeps = {}): KeepAwakeHandle {
  const platform = deps.platform ?? process.platform;
  const onLog = deps.onLog ?? (() => {});
  if (platform !== "darwin") return { stop: () => {} };

  const pid = deps.pid ?? process.pid;
  const spawn = deps.spawn ?? nodeSpawn;
  const flagsRaw =
    deps.flagsEnv ?? process.env.PMK_GATEWAY_CAFFEINATE_FLAGS ?? DEFAULT_CAFFEINATE_FLAGS;
  const flags = flagsRaw.split(/\s+/).filter(Boolean);
  const args = [...flags, "-w", String(pid)];

  let child: ChildProcess | undefined;
  let stopped = false;
  try {
    child = spawn("caffeinate", args, { stdio: "ignore" });
    child.unref();
    child.on("error", (err: Error) => {
      onLog(`keep-awake: caffeinate failed to start (${err.message}); gateway is NOT throttle-protected`);
    });
    child.on("exit", (code) => {
      if (!stopped) {
        onLog(`keep-awake: caffeinate exited unexpectedly (code ${code}); gateway is NOT throttle-protected`);
      }
    });
  } catch (err) {
    onLog(`keep-awake: could not spawn caffeinate (${(err as Error).message}); continuing without throttle protection`);
  }

  return {
    stop: () => {
      stopped = true;
      try {
        child?.kill();
      } catch {
        /* already gone */
      }
    },
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd packages/cli && node --import tsx --test test/keep-awake.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire into `runGateway`**

In `packages/cli/src/gateway/index.ts`:

Add the import near the other gateway imports at the top of the file (alongside `startHeartbeat`):
```ts
import { startKeepAwake } from "./keep-awake";
```

Right after the heartbeat is started (the `log(\`heartbeat ticking …\`)` line, ~line 83), add:
```ts
  const keepAwake = startKeepAwake({ onLog: log });
```

In `shutdown`, immediately after `hb.stop();` (~line 104), add:
```ts
    keepAwake.stop();
```

In the start-error `catch` block, after `hb.stop();` (~line 147), add:
```ts
    keepAwake.stop();
```

- [ ] **Step 6: Verify build + run the keep-awake test again**

Run: `cd packages/cli && npx tsc --noEmit -p tsconfig.json && node --import tsx --test test/keep-awake.test.ts`
Expected: tsc exit 0; PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/gateway/keep-awake.ts packages/cli/test/keep-awake.test.ts packages/cli/src/gateway/index.ts
git commit -m "feat(gateway): keep-awake caffeinate wrapper, wired into runGateway"
```

---

## Task 3: pong-tap `Logger` (Unit C)

**Files:**
- Create: `packages/cli/src/gateway/slack/socket-logger.ts`
- Test: `packages/cli/test/socket-logger.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/socket-logger.test.ts`:

```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import type { Logger } from "@slack/logger";

function recordingLogger() {
  const lines: Array<{ level: string; msg: string }> = [];
  const base = {
    debug: (...m: unknown[]) => lines.push({ level: "debug", msg: m.join(" ") }),
    info: (...m: unknown[]) => lines.push({ level: "info", msg: m.join(" ") }),
    warn: (...m: unknown[]) => lines.push({ level: "warn", msg: m.join(" ") }),
    error: (...m: unknown[]) => lines.push({ level: "error", msg: m.join(" ") }),
    setLevel: () => {},
    getLevel: () => "warn",
    setName: () => {},
  } as unknown as Logger;
  return { base, lines };
}

describe("createPongTapLogger", () => {
  it("bumps on the real SDK pong/ping-timeout strings and forwards them", async () => {
    const { createPongTapLogger } = await import("../src/gateway/slack/socket-logger");
    const { base, lines } = recordingLogger();
    let bumps = 0;
    const log = createPongTapLogger(() => { bumps += 1; }, base);
    log.warn("A pong wasn't received from the server before the timeout of 5000ms!");
    log.warn("A ping wasn't received from the server before the timeout of 30000ms!");
    assert.equal(bumps, 2);
    assert.equal(lines.filter((l) => l.level === "warn").length, 2); // still forwarded
  });

  it("does not bump on a non-matching warn", async () => {
    const { createPongTapLogger } = await import("../src/gateway/slack/socket-logger");
    const { base, lines } = recordingLogger();
    let bumps = 0;
    const log = createPongTapLogger(() => { bumps += 1; }, base);
    log.warn("some unrelated warning");
    assert.equal(bumps, 0);
    assert.equal(lines.length, 1);
  });

  it("forwards every level to the wrapped logger (observe-only tap)", async () => {
    const { createPongTapLogger } = await import("../src/gateway/slack/socket-logger");
    const { base, lines } = recordingLogger();
    const log = createPongTapLogger(() => {}, base);
    log.debug("d"); log.info("i"); log.warn("w"); log.error("e");
    assert.deepEqual(lines.map((l) => l.level), ["debug", "info", "warn", "error"]);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd packages/cli && node --import tsx --test test/socket-logger.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `socket-logger.ts`**

Create `packages/cli/src/gateway/slack/socket-logger.ts`:

```ts
/**
 * A `Logger` wrapper for the Socket-Mode client that taps pong/ping
 * timeout WARN lines (the client surfaces these only as log lines, not
 * events) and forwards them to `onPongTimeout`, while passing EVERY log
 * line through to the wrapped logger unchanged. Observe-only: it never
 * swallows or rewrites a log.
 */
import { ConsoleLogger, LogLevel, type Logger } from "@slack/logger";

const PONG_TIMEOUT_RE = /pong wasn't received|ping wasn't received/i;

export function createPongTapLogger(onPongTimeout: () => void, base?: Logger): Logger {
  const sink: Logger = base ?? new ConsoleLogger();
  sink.setLevel(LogLevel.WARN);
  return {
    debug: (...msgs: unknown[]) => sink.debug(...msgs),
    info: (...msgs: unknown[]) => sink.info(...msgs),
    warn: (...msgs: unknown[]) => {
      if (PONG_TIMEOUT_RE.test(msgs.join(" "))) onPongTimeout();
      sink.warn(...msgs);
    },
    error: (...msgs: unknown[]) => sink.error(...msgs),
    setLevel: (level: LogLevel) => sink.setLevel(level),
    getLevel: () => sink.getLevel(),
    setName: (name: string) => sink.setName(name),
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd packages/cli && node --import tsx --test test/socket-logger.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/slack/socket-logger.ts packages/cli/test/socket-logger.test.ts
git commit -m "feat(gateway): pong-timeout tap logger for socket health"
```

---

## Task 4: `PresenceBroadcaster.watchdogTerminate`

**Files:**
- Modify: `packages/cli/src/gateway/slack/presence.ts`
- Test: `packages/cli/test/socket-watchdog-alert.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/socket-watchdog-alert.test.ts`:

```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import type { WebClient } from "@slack/web-api";

function fakeWeb(opts: { hang?: boolean } = {}) {
  const posts: Array<{ channel: string; text: string }> = [];
  const web = {
    conversations: {
      open: async ({ users }: { users: string }) => ({ channel: { id: `D-${users}` } }),
    },
    chat: {
      postMessage: async (a: { channel: string; text: string }) => {
        if (opts.hang) return new Promise(() => {}); // never settles
        posts.push(a);
        return { ok: true };
      },
    },
  } as unknown as WebClient;
  return { web, posts };
}

describe("PresenceBroadcaster.watchdogTerminate", () => {
  it("DMs each admin via conversations.open → postMessage", async () => {
    const { PresenceBroadcaster } = await import("../src/gateway/slack/presence");
    const { web, posts } = fakeWeb();
    const p = new PresenceBroadcaster({ web, onLog: () => {}, gracefulShutdown: false });
    await p.watchdogTerminate({ adminIds: ["U1", "U2"], attempts: 3, alertTimeoutMs: 5_000 });
    assert.deepEqual(posts.map((x) => x.channel).sort(), ["D-U1", "D-U2"]);
    assert.ok(posts.every((x) => /self-terminated/i.test(x.text)));
  });

  it("returns within the alert timeout even if Slack hangs", async () => {
    const { PresenceBroadcaster } = await import("../src/gateway/slack/presence");
    const { web } = fakeWeb({ hang: true });
    const p = new PresenceBroadcaster({ web, onLog: () => {}, gracefulShutdown: false });
    const start = Date.now();
    await p.watchdogTerminate({ adminIds: ["U1"], attempts: 3, alertTimeoutMs: 60 });
    assert.ok(Date.now() - start < 2_000); // did not wait on the hung post
  });

  it("with no admins, does not post and still resolves", async () => {
    const { PresenceBroadcaster } = await import("../src/gateway/slack/presence");
    const { web, posts } = fakeWeb();
    const p = new PresenceBroadcaster({ web, onLog: () => {}, gracefulShutdown: false });
    await p.watchdogTerminate({ adminIds: [], attempts: 3, alertTimeoutMs: 5_000 });
    assert.equal(posts.length, 0);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd packages/cli && node --import tsx --test test/socket-watchdog-alert.test.ts`
Expected: FAIL — `watchdogTerminate is not a function`.

- [ ] **Step 3: Implement `watchdogTerminate` on `PresenceBroadcaster`**

In `packages/cli/src/gateway/slack/presence.ts`, add this method to the `PresenceBroadcaster` class (e.g. after `backOnline()`):

```ts
  /**
   * Loud-exit path for the SocketWatchdog. Records the offline
   * transition (broadcast:false — this is an operator alert, NOT the
   * stakeholder fan-out) FIRST and synchronously, then DMs each admin
   * under a hard timeout so a hung Slack call can never delay the
   * caller's process.exit. Best-effort: per-DM errors are swallowed;
   * the whole admin phase is abandoned at `alertTimeoutMs`.
   */
  async watchdogTerminate(opts: {
    adminIds: string[];
    attempts: number;
    alertTimeoutMs: number;
  }): Promise<void> {
    const seq = ++this.seq;
    appendGatewayEvent({
      type: "gateway.offline",
      seq,
      reason: "watchdog-unhealthy",
      broadcast: false,
    });
    if (opts.adminIds.length === 0) {
      this.opts.onLog("watchdog loud-exit: no admins configured; offline event recorded, exiting");
      return;
    }
    const text =
      `:rotating_light: pmk gateway self-terminated: Socket-Mode unrecoverable ` +
      `after ${opts.attempts} reconnect attempts. The bot is offline until restarted.`;
    const alerts = Promise.allSettled(
      opts.adminIds.map((id) => this.dmSafe(id, text)),
    );
    const timeout = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, opts.alertTimeoutMs);
      if (typeof t.unref === "function") t.unref();
    });
    await Promise.race([alerts.then(() => undefined), timeout]);
  }
```

(`dmSafe`, `this.seq`, and `appendGatewayEvent` already exist in this file. No new imports.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd packages/cli && node --import tsx --test test/socket-watchdog-alert.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/slack/presence.ts packages/cli/test/socket-watchdog-alert.test.ts
git commit -m "feat(gateway): PresenceBroadcaster.watchdogTerminate (offline event + time-boxed admin DMs)"
```

---

## Task 5: `SocketWatchdog` state machine

**Files:**
- Create: `packages/cli/src/gateway/slack/socket-watchdog.ts`
- Test: `packages/cli/test/socket-watchdog.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/socket-watchdog.test.ts`:

```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { SocketHealth } from "../src/gateway/socket-health";

// A controllable clock + manual tick driver (we never start the real timer).
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
    // one failed cycle to seed a failure
    h.health.recordConnState("reconnecting", 0);
    h.set(61_000); await wd.tick();                 // reconnect issued, pending
    h.health.recordConnState("connected", h.at());  // recovers
    h.set(h.at() + 200_000); await wd.tick();        // > 180s stable → reset
    // now drive 3 more isolated unhealthy ticks shouldn't immediately exit
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
    // next unhealthy tick confirms the 3rd failure and exits
    h.health.recordConnState("reconnecting", h.at());
    h.set(h.at() + 61_000);
    await wd.tick();
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
      await wd.tick(); // each throw → failedReconnects++
    }
    h.health.recordConnState("reconnecting", h.at());
    h.set(h.at() + 61_000);
    await wd.tick(); // failures already 3 → loud exit
    assert.equal(h.exited(), 1);
  });

  it("a reconnect that never settles is timed out and counts as failed", async () => {
    const { SocketWatchdog } = await import("../src/gateway/slack/socket-watchdog");
    const h = harness({ reconnect: () => new Promise(() => {}) }); // never settles
    h.deps.reconnectTimeoutMs = 50;
    const wd = new SocketWatchdog(h.deps);
    h.health.recordConnState("reconnecting", h.at());
    h.set(h.at() + 61_000);
    await wd.tick(); // times out → failed, in-flight cleared
    assert.ok(h.log.some((m) => /reconnect failed|timed out/i.test(m)));
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd packages/cli && node --import tsx --test test/socket-watchdog.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `socket-watchdog.ts`**

Create `packages/cli/src/gateway/slack/socket-watchdog.ts`:

```ts
/**
 * Self-heal watchdog for the Socket-Mode connection. On an unhealthy
 * verdict it forces an in-process reconnect; a reconnect is only
 * "failed" if the socket goes unhealthy again before
 * STABLE_CONNECTED_RESET_MS of continuous health (or its reconnect
 * throws/times out). After REUNHEALTHY_ATTEMPTS confirmed failures the
 * next unhealthy tick performs a loud exit. The single-flight flag
 * guards only the watchdog's OWN reconnect — SDK auto-reconnect churn is
 * caught by assess()'s UNSTABLE_CONN_LIMIT_MS and is NOT skipped.
 */
import type { SocketHealth } from "../socket-health";

/** Confirmed-failed reconnects before loud exit. */
export const REUNHEALTHY_ATTEMPTS = 3;
/** Continuous connected+no-pong-timeout needed to reset the failure counter. */
export const STABLE_CONNECTED_RESET_MS = 180_000;
/** Per-reconnect cap; timing out = a failed reconnect (can't pin in-flight). */
export const WATCHDOG_RECONNECT_TIMEOUT_MS = 45_000;
/** Hard cap on the loud-exit admin-alert phase. */
export const WATCHDOG_ALERT_TIMEOUT_MS = 15_000;
/** Evaluation cadence (dedicated timer — heartbeat exposes no hook). */
export const WATCHDOG_INTERVAL_MS = 30_000;

export interface SocketWatchdogDeps {
  health: SocketHealth;
  /** Rebuild the connection (adapter: disconnect() then start()). */
  reconnect: () => Promise<void>;
  /** Loud-exit alert (adapter: presence.watchdogTerminate(...)). */
  terminate: () => Promise<void>;
  exit: (code: number) => void;
  now: () => number;
  onLog: (msg: string) => void;
  /** Override for tests; defaults to WATCHDOG_RECONNECT_TIMEOUT_MS. */
  reconnectTimeoutMs?: number;
}

export class SocketWatchdog {
  private timer?: ReturnType<typeof setInterval>;
  private failedReconnects = 0;
  private inFlight = false;
  private pendingEvaluation = false;

  constructor(private readonly deps: SocketWatchdogDeps) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), WATCHDOG_INTERVAL_MS);
    if (this.timer && typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    const now = this.deps.now();
    if (this.deps.health.assess(now) === "healthy") {
      const stableSince = this.deps.health.lastStableConnectedSince(now);
      if (stableSince !== null && now - stableSince >= STABLE_CONNECTED_RESET_MS) {
        if (this.failedReconnects > 0 || this.pendingEvaluation) {
          this.deps.onLog("watchdog: socket stable; clearing reconnect failure count");
        }
        this.failedReconnects = 0;
        this.pendingEvaluation = false;
      }
      return;
    }

    // unhealthy
    if (this.inFlight) return; // our own reconnect is mid-flight

    if (this.pendingEvaluation) {
      // the previous forced reconnect did not reach sustained stability
      this.failedReconnects += 1;
      this.pendingEvaluation = false;
      this.deps.onLog(`watchdog: reconnect #${this.failedReconnects} did not stabilise`);
    }

    if (this.failedReconnects >= REUNHEALTHY_ATTEMPTS) {
      this.deps.onLog(
        `watchdog: Socket-Mode unrecoverable after ${this.failedReconnects} reconnects; loud exit`,
      );
      await this.deps.terminate();
      this.deps.exit(1);
      return;
    }

    await this.forceReconnect();
  }

  private async forceReconnect(): Promise<void> {
    this.inFlight = true;
    const timeoutMs = this.deps.reconnectTimeoutMs ?? WATCHDOG_RECONNECT_TIMEOUT_MS;
    try {
      await withTimeout(this.deps.reconnect(), timeoutMs);
      this.deps.health.reset(this.deps.now());
      this.pendingEvaluation = true;
      this.deps.onLog("watchdog: forced reconnect issued, awaiting stability");
    } catch (err) {
      this.failedReconnects += 1;
      this.pendingEvaluation = false;
      this.deps.onLog(
        `watchdog: forced reconnect failed (${(err as Error).message}); failures=${this.failedReconnects}`,
      );
    } finally {
      this.inFlight = false;
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`reconnect timed out after ${ms}ms`)), ms);
    if (typeof t.unref === "function") t.unref();
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e as Error); },
    );
  });
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd packages/cli && node --import tsx --test test/socket-watchdog.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/slack/socket-watchdog.ts packages/cli/test/socket-watchdog.test.ts
git commit -m "feat(gateway): SocketWatchdog escalating self-heal state machine"
```

---

## Task 6: Wire health + logger + watchdog into `SlackAdapter`

**Files:**
- Modify: `packages/cli/src/gateway/slack/index.ts`

This task has no new unit test — the state machine, health, logger, and alert are all covered in Tasks 1/3/4/5. It is verified by the full suite staying green (Task 7 Step 1) and a live sanity run (Task 7 Step 2). Keep the diff minimal and mechanical.

- [ ] **Step 1: Add imports**

At the top of `packages/cli/src/gateway/slack/index.ts`, alongside the existing imports, add:
```ts
import { SocketHealth, type ConnState } from "../socket-health";
import { createPongTapLogger } from "./socket-logger";
import {
  SocketWatchdog,
  WATCHDOG_ALERT_TIMEOUT_MS,
  REUNHEALTHY_ATTEMPTS,
} from "./socket-watchdog";
```

- [ ] **Step 2: Add fields to the `SlackAdapter` class**

Next to the other private fields (after `private readonly presence: PresenceBroadcaster;`), add:
```ts
  /** Socket-Mode health tracker (fed by the pong-tap logger + conn-state events). */
  private readonly health: SocketHealth;
  /** Self-heal watchdog; started in start(), stopped in stop(). */
  private watchdog?: SocketWatchdog;
```

- [ ] **Step 3: Construct health + inject the pong-tap logger into the real socket**

In the constructor, replace the real-socket construction block:
```ts
    if (opts.socket) {
      this.socket = opts.socket;
    } else {
      this.socket = new SocketModeClient({
        appToken: opts.config.slack.appToken!,
        logLevel: "warn" as never, // Avoid noisy stdout in normal operation.
      });
    }
```
with:
```ts
    this.health = new SocketHealth(Date.now());
    if (opts.socket) {
      this.socket = opts.socket;
    } else {
      this.socket = new SocketModeClient({
        appToken: opts.config.slack.appToken!,
        // Tap pong/ping-timeout WARN lines into the health tracker; the
        // logger still prints exactly as before (level warn).
        logger: createPongTapLogger(() => this.health.recordPongTimeout(Date.now())),
      } as never);
    }
```
(Note: `this.health` must be assigned before any code path that references it. Place the `this.health = …` line at the very start of the socket block, before the `if (opts.socket)`.)

- [ ] **Step 4: Register conn-state listeners + construct/start the watchdog in `start()`**

In `start()`, replace the two existing socket lifecycle listeners:
```ts
    this.socket.on("disconnected", () =>
      this.onLog("slack socket disconnected"),
    );
    this.socket.on("reconnect", () => this.onLog("slack socket reconnected"));
```
with the correct five SDK states feeding health (plus breadcrumb logs on the two interesting ones):
```ts
    const CONN_STATES: ConnState[] = [
      "connecting",
      "connected",
      "reconnecting",
      "disconnecting",
      "disconnected",
    ];
    for (const st of CONN_STATES) {
      this.socket.on(st, () => this.health.recordConnState(st, Date.now()));
    }
    this.socket.on("connected", () => this.onLog("slack socket connected"));
    this.socket.on("disconnected", () => this.onLog("slack socket disconnected"));
```

First add a `realTransport` flag so `start()` only runs the watchdog against a real socket (not the test fake-transport). Add this private field next to `health`:
```ts
  private readonly realTransport: boolean;
```
and set it in the constructor right after `const useFakeTransport = …` is computed:
```ts
    this.realTransport = !useFakeTransport;
```

Then, immediately after the conn-state listener registration above, add the watchdog construction in `start()`:
```ts
    // Self-heal watchdog: detect a wedged socket → in-process reconnect →
    // loud exit if unrecoverable. Skipped under fake transport (tests).
    if (this.realTransport) {
      this.watchdog = new SocketWatchdog({
        health: this.health,
        reconnect: async () => {
          await this.socket.disconnect();
          await this.socket.start();
        },
        terminate: () =>
          this.presence.watchdogTerminate({
            adminIds: this.config.admins,
            attempts: REUNHEALTHY_ATTEMPTS,
            alertTimeoutMs: WATCHDOG_ALERT_TIMEOUT_MS,
          }),
        exit: (code) => process.exit(code),
        now: () => Date.now(),
        onLog: this.onLog,
      });
      this.watchdog.start();
    }
```
(Replace the temporary `opts_hasFakeTransport_PLACEHOLDER` scaffold line — do not leave it in.)

- [ ] **Step 5: Stop the watchdog in `stop()`**

In `SlackAdapter.stop(...)`, before the drain/`presence.offline()` logic (near the top of the method), add:
```ts
    this.watchdog?.stop();
```

- [ ] **Step 6: Build + run the full suite**

Run: `cd packages/cli && npm test`
Expected: typecheck passes; all tests pass (≥ 483 + the new suites). If tsc complains about `this.socket.on(st, …)` state names, cast the event name: `this.socket.on(st as never, …)` — the SDK types the emitter loosely; match whatever the existing `.on("message", …)` calls accept.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/gateway/slack/index.ts
git commit -m "feat(gateway): wire SocketHealth + pong-tap logger + watchdog into SlackAdapter"
```

---

## Task 7: Full-suite green + live sanity + self-review

- [ ] **Step 1: Full suite**

Run: `cd packages/cli && npm test`
Expected: exit 0; pass count = prior 483 + new tests (socket-health 5, keep-awake 5, socket-logger 3, watchdog-alert 3, watchdog 6).

- [ ] **Step 2: Live sanity on the host (manual, optional but recommended)**

The watchdog/keep-awake only exercise fully against a real daemon. With the gateway built and running on macOS:
- `pmk gateway start` (foreground) → confirm a `caffeinate` child exists: `pgrep -fl "caffeinate .* -w $(cat ~/.pmk/gateway/gateway.pid)"`.
- Confirm normal operation produces no spurious watchdog log lines over ~5 min (no false `forced reconnect`).
- Stop with Ctrl+C → confirm the `caffeinate` child is gone (`pgrep caffeinate` no longer lists the `-w <pid>` one) and a normal `gateway.offline` (reason `shutdown`) event is written (NOT `watchdog-unhealthy`).

Record what was checked; do not fake results. If a real wedged-socket reproduction isn't feasible, note that the watchdog escalation is covered by the unit tests and the live check only validates keep-awake + clean shutdown.

- [ ] **Step 3: Self-review against the spec**

Confirm: throttle-proofing default `-is` + env override (Task 2); watchdog detection via pong-flood + unstable-conn (Tasks 1/5); single-flight only on the watchdog's own reconnect, SDK churn not skipped (Task 5); reconnect timeout (Task 5); attempt-reset gated on `STABLE_CONNECTED_RESET_MS` (Task 5); loud exit = offline event `broadcast:false` via presence + time-boxed admin DMs + `exit(1)`, empty admins → no fan-out (Task 4); Unit C logger tests (Task 3); five SDK conn states incl. `disconnecting` (Tasks 1/6). List any gap and add a task.

- [ ] **Step 4: Finish the branch**

Use **superpowers:finishing-a-development-branch** to verify tests, then choose merge/PR. Local main has been the working branch this cycle; a v0.x.1-style release (commit-on-main → tag) fits this reliability fix per the release-workflow preference.

---

## Self-Review (completed during planning)

- **Spec coverage:** keep-awake (`-is` default + `PMK_GATEWAY_CAFFEINATE_FLAGS` override + child exit/error handling) → Task 2; `SocketHealth` (pong window, unstable-conn, reset = pong-evidence-only, `lastStableConnectedSince`) → Task 1; pong-tap logger → Task 3; watchdog state machine (single-flight own-reconnect-only, SDK-churn-not-skipped, reconnect timeout, failed-on-confirmed-failure, exit-on-next-unhealthy-after-M, stable-reset) → Task 5; loud exit (offline `broadcast:false` via presence + `conversations.open`→DM admins + alert timeout + always exit) → Task 4; wiring (logger injection, 5 conn states, construct/start/stop) → Task 6; thresholds as named constants → Tasks 1/5; full-suite + live sanity → Task 7. All spec sections map to a task.
- **Placeholder scan:** no "TBD"/"TODO"/"handle edge cases" placeholders; every code step ships the real code and every test step ships concrete assertions. Task 6 (pure wiring) intentionally has no new unit test — its behaviour is covered by Tasks 1/3/4/5 and validated by the full suite + the live sanity check in Task 7.
- **Type consistency:** `ConnState` (Task 1) is the single source for the five state strings, imported in Task 6. `SocketHealth` method names (`recordPongTimeout`, `recordConnState`, `assess`, `reset`, `lastStableConnectedSince`) match across Tasks 1/5/6. `watchdogTerminate({adminIds, attempts, alertTimeoutMs})` (Task 4) matches the call site (Task 6). `SocketWatchdogDeps` fields match the adapter wiring (Task 6).

## Out of scope (future)

launchd/systemd service + boot auto-start; a `watchdogAlertChannelId` config; adaptive thresholds; active health probes; a `pmk gateway doctor` un-throttle-proofed warning.

