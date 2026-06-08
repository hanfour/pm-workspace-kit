# Gateway ops toolkit — design

Status: approved (brainstorm 2026-06-08)
Scope: `packages/cli` gateway lifecycle + runtime health + service install.

## Context

Engineers need to operate the gateway daemon, but today there is no clean
surface for it:

- **Lifecycle:** `pmk gateway start` exists (foreground, blocks; SIGINT/SIGTERM
  → graceful shutdown with 25s drain + offline broadcast + shutdown marker;
  `gatewayRunningPid()` guards double-start). There is **no `stop`, no
  `restart`**. Restart today = manually SIGTERM the pid then start again.
- **Runtime health:** `pmk gateway status` reports only the pid; the Slack
  `/pmk admin status` reports only **config** (mra workspace, audience default,
  admin count…) — neither shows whether the bot is actually *healthy*
  (socket connected, heartbeat fresh, watchdog flapping, recently serving).
  The live health signals exist (`heartbeat.ts`, `socket-health.ts`,
  `slack/socket-watchdog.ts`, `events.ts` `turn.processed`/`gateway.offline`)
  but are not surfaced.
- **Always-on:** "crash → auto-respawn" relies on an external supervisor; v0.19
  added a loud-exit designed for one, but there's no first-class way to install
  it. The host currently runs `start` in the foreground wrapped by the v0.19
  `caffeinate` keep-awake.

This adds a cohesive **ops toolkit**: lifecycle commands (stop/restart),
runtime health (`/doctor`), and a launchd service installer — all aware of
whether the gateway is **supervised** (launchd) or **standalone**.

## Goals

- `pmk gateway stop` / `restart` that do the right thing whether the gateway is
  standalone or under launchd (auto-detected).
- `/pmk admin doctor` (Slack) reports **live** runtime health from the daemon's
  in-memory state.
- `pmk gateway status` (enhanced) reports **persisted** health that works even
  when the bot is down.
- `pmk gateway install-service` generates a launchd LaunchAgent for one-command
  always-on (crash auto-respawn).
- Reuse existing signals (heartbeat / socket-health / watchdog / events); no new
  telemetry.

## Non-goals (YAGNI)

- No pm2 / systemd (macOS → launchd only).
- No restart from Slack (a daemon restarting itself inside a slash-command
  handler is fragile; a dead bot can't be restarted from Slack anyway).
- No change to the existing `/pmk admin status` (config view) — `doctor` is a
  new, separate runtime view.
- No secrets in the launchd plist (tokens stay in gateway.json as `{cmd}`/`{env}`
  references per the v0.20.0 secret-references feature).

## Architecture

### Unit 0 — run-state file (foundation)

Today liveness is a bare pid file read by `gatewayRunningPid()`
(`gateway/index.ts:181`). Extend to a small JSON run-state
`~/.pmk/gateway/runtime.json`:

```ts
interface GatewayRunState {
  pid: number;
  startedAt: number;            // ms epoch — drives uptime
  phase: "starting" | "ready";  // ready ONLY after adapter.start() succeeds
  supervised: "launchd" | null;
  serviceLabel?: string;        // e.g. "com.pmk.gateway"
}
```

- Written by `runGateway`: `phase:"starting"` at process start, then
  **rewritten `phase:"ready"` only after `SlackAdapter.start()` resolves**
  (socket connected + auth ok). This is what `restart` polls on — heartbeat/pid
  alone are written early and would report success while Slack startup is still
  failing. The file may persist after the process dies; the existing shutdown
  marker stays as-is.
- `supervised` / `serviceLabel` (of the *running* process) are read from env at
  start: the launchd plist sets `PMK_SERVICE=launchd` + `PMK_SERVICE_LABEL=<label>`.
  Absent → `null` (standalone).

**Two run-state readers (don't conflate):**
- `readGatewayRunStateRaw(): GatewayRunState | undefined` — the file as-is,
  possibly stale (pid may be dead). Used by `status` (must work when down).
- `gatewayLiveRunState(): GatewayRunState | undefined` — raw + liveness-checked
  via `process.kill(pid, 0)`; `undefined` if not actually running. Used by
  start/stop/restart. `gatewayRunningPid()` derives from this.

**Three distinct launchd states (do NOT conflate "installed" with "loaded"):**
`launchctl bootout` *unloads* the service from the launchd domain — the plist
stays on disk but `kickstart` then fails (not loaded). So model three things:
- `installedPlist(): { label, plistPath } | undefined` — the plist file exists
  at `~/Library/LaunchAgents/com.pmk.gateway.plist`.
- `loadedService(label): boolean` — loaded in the domain (`launchctl print
  gui/<uid>/<label>` succeeds).
- `gatewayLiveRunState()` — the process is actually alive.

The lifecycle decision (used by A):
- live + `supervised==="launchd"`, or `loadedService` → launchctl `kickstart -k`.
- `installedPlist` but NOT loaded → `launchctl bootstrap gui/<uid> <plistPath>`
  (RunAtLoad starts it), for restart/start.
- no plist → standalone.

### Unit A — `stop` / `restart`

Add `case "stop"` / `case "restart"` to `commands/gateway/index.ts` and
`stopCmd` / `restartCmd` in `commands/gateway/ops.ts`. Both use the **lifecycle
decision** from Unit 0 (live-supervised / `loadedService` / `installedPlist`
unloaded / standalone).

**`launchctl` is invoked shell-free** — `execFile("launchctl", [verb,
"gui/" + uid + "/" + label, …])` with `uid = process.getuid()` and a validated
label (`/^[A-Za-z0-9._-]+$/`; the label comes from persisted state/env). Never a
shell command string.

**`pmk gateway stop`:**
- Not running and not installed → "gateway is not running." (no error)
- launchctl path → `execFile("launchctl", ["bootout", "gui/<uid>/<label>"])`
  (plain SIGTERM would be respawned by KeepAlive). Report success/failure.
- standalone (live) → `process.kill(pid, "SIGTERM")` (existing graceful path:
  25s drain + offline broadcast + marker), then poll `process.kill(pid,0)` until
  it exits (cap ~30s); report graceful stop, or still-running on timeout.

**`pmk gateway restart`:**
- `loadedService` (or live-supervised) → `execFile("launchctl", ["kickstart",
  "-k", "gui/<uid>/<label>"])` (one-shot kill + restart). Report.
- `installedPlist` but **not loaded** (e.g. after a prior `stop`/bootout) →
  `execFile("launchctl", ["bootstrap", "gui/<uid>", <plistPath>])` (RunAtLoad
  starts it). `kickstart` would FAIL here — must bootstrap first.
- standalone → run the stop path (SIGTERM + wait for exit), then re-launch
  detached: `spawn(<node>, [<dist>/index.js, "gateway", "start"], { detached:
  true, stdio: ["ignore", <out fd>, <err fd>] })`, `child.unref()`. **stdout/err
  go to the same log files as the LaunchAgent** (`~/.pmk/logs/gateway.{out,err}.log`,
  opened with `fs.openSync(..., "a")`) — NOT `"ignore"` — so a failed start is
  diagnosable. Then **poll run-state for `phase:"ready"` from the new pid for up
  to ~15s** (NOT just heartbeat/pid — those are written early, before
  `adapter.start()`; a Slack-auth/socket failure would otherwise look like a
  success). Report success only on `ready`; else "start may have failed — see
  ~/.pmk/logs/gateway.err.log" + the child's exit if it already died.
- Not running → just start (detached standalone with the same logging + `ready`
  poll) or `bootstrap`/`kickstart` (if installed/loaded).

If `launchctl` is missing / not macOS, fall back to the standalone path or
report a clear error.

### Unit B — `/doctor` runtime health (two surfaces, divided)

**Slack `/pmk admin doctor`** — live, from the daemon's in-memory state.
Add `adminDoctor` + `case "doctor"` in `slack/admin.ts`. **Main engineering
point:** `adminStatus` only `loadRawGatewayConfig()`s today; `adminDoctor`
needs the daemon's live handles. Their state is private, so add **public
snapshot APIs**:
- `SocketHealth.snapshot(now: number): { state, pongTimeoutsInWindow, unstableMs }`
- `SocketWatchdog.snapshot(): { flaps, reconnects, confirmedFailures }`

**DI must pass a PROVIDER FUNCTION, not a construction-time snapshot** — a value
captured when `SlashCommandHandler` is built would freeze `/pmk admin doctor` at
old state forever. Pass `getRuntimeHealthSnapshot(): RuntimeHealthSnapshot` (a
closure over the live `SocketHealth`/`SocketWatchdog` + `startedAt`) that reads
`SocketHealth.snapshot(Date.now())` / `SocketWatchdog.snapshot()` **at command
time**, on each `/doctor` invocation. When the provider is absent (e.g. dry-run)
metrics render "unknown" rather than throwing.

Reported (live):
| metric | source |
|---|---|
| socket conn state | `SocketHealth.state` (connected / reconnecting / …) |
| pong-timeouts in window, unstable duration | `SocketHealth` (60s window) |
| watchdog flap/reconnect count, confirmed failures | `SocketWatchdog` (session) |
| heartbeat age | `heartbeat` (last tick) |
| turns served last 30m, last offline reason | `events` (`turn.processed`, `gateway.offline.reason`) |
| uptime | run-state `startedAt` |

**CLI `pmk gateway status`** — enhanced, persisted (works when bot is down).
Reports from files/events, no daemon memory. **Reads `readGatewayRunStateRaw()`
(not liveness-gated) and `loadRawGatewayConfig()` (NOT `loadGatewayConfig()`) —
it MUST NOT resolve secret references: a status command must never execute a
`{cmd}` (`op read …`) just to print status.** Secret/auth validation stays in
`gateway doctor`.
| metric | source |
|---|---|
| pid alive? | `process.kill(pid,0)` on raw run-state pid |
| supervised? + label | raw run-state |
| heartbeat age | heartbeat file (see thresholds below) |
| last online/offline + reason | events |
| turns served last 30m | events `turn.processed` |
| uptime | raw run-state `startedAt` |
| live socket state | **N/A** — print "use Slack `/pmk admin doctor` for live socket" |

**Heartbeat aging thresholds** (used by both verdict + the age label):
`fresh` < 30s, `aging` 30s–`HEARTBEAT_STALE_MS` (60s), `stale` ≥ 60s.

**Shared verdict helper** — `verdict({ pidAlive, heartbeatAge, live? })` where
`live?` (`{ socketState, flaps }`) is **optional**, because CLI has no socket/
watchdog memory:
- 🔴 down = `!pidAlive` OR heartbeat `stale`.
- with `live` (Slack doctor): 🟡 degraded if `socketState !== "connected"` OR
  `flaps > 0` OR heartbeat `aging`; else 🟢 healthy.
- **without `live` (CLI status): cap at 🟡** — `🔴` if down, else
  `🟡 "process + heartbeat ok, live socket unknown — see /pmk admin doctor"`.
  CLI never claims 🟢 (it can't confirm the socket). Unknown socket never lowers
  to 🔴.

Permission: Slack side gated by the existing `/pmk admin` admin check; CLI runs
on the host.

### Unit C — `install-service` (launchd)

`pmk gateway install-service [--load] [--uninstall]` (macOS only):
- Writes `~/Library/LaunchAgents/com.pmk.gateway.plist`:
  - `Label` = `com.pmk.gateway`
  - `ProgramArguments` = absolute `[<node>, <dist>/index.js, gateway, start]`
  - `RunAtLoad` = true, `KeepAlive` = true (crash/exit → respawn; pairs with
    v0.19 loud-exit)
  - `EnvironmentVariables` = `{ PMK_SERVICE: "launchd", PMK_SERVICE_LABEL:
    "com.pmk.gateway", HOME, PATH }` — `PATH` so `{cmd}` references (e.g. `op`)
    resolve. **No secrets** (tokens via gateway.json references).
  - `StandardOutPath` / `StandardErrorPath` → `~/.pmk/logs/gateway.{out,err}.log`
  - `ProcessType=Background`
  - `WorkingDirectory` = the configured `mraWorkspace` if set and valid (has
    `.collab/repos.json`); else the install-time cwd, with a printed warning that
    mra-ask falls back to cwd-walk from here (recommend setting `mraWorkspace`).
- **`{env}` secret refs under launchd:** since the plist carries **no secrets**,
  a gateway.json secret that is an `{env}` reference will NOT resolve under the
  LaunchAgent (launchd starts with a minimal env). `install-service` MUST inspect
  the raw secret sources (`loadRawGatewayConfig`) and, if any is `{env}`, **warn
  loudly**: "the LaunchAgent won't have <VAR>; use a `{cmd}` reference, a literal,
  or add the var to the plist yourself (accepting it's on disk)." Default
  LaunchAgent supports **literal / `{cmd}`** secrets out of the box.
- Prints the `launchctl bootstrap gui/<uid> <plist>` + `launchctl enable` steps;
  with `--load`, runs them (shell-free `execFile`).
- `--uninstall` → `launchctl bootout` + remove the plist.
- Keep the v0.19 `caffeinate` keep-awake inside `start` even under launchd
  (App Nap can still throttle a backgrounded LaunchAgent).
- Idempotent: plist exists → warn and require `--force` to overwrite. Non-macOS
  → clear error.

## Error handling

- stop/restart when not running → informational message, exit 0.
- `launchctl` failure / not macOS → fall back to standalone path where sensible,
  else report the exact command + error (never the daemon's secrets).
- `adminDoctor` when a handle is unavailable (e.g. dry-run) → render "unknown"
  for that metric rather than throwing.
- install-service: never write a secret into the plist; refuse to overwrite
  without `--force`.

## Testing

- run-state: write `phase:"starting"` on start then `"ready"` after a (faked)
  `adapter.start()` resolves; `readGatewayRunStateRaw` returns a stale file
  (dead pid) verbatim; `gatewayLiveRunState` undefined for a dead pid;
  `supervised` from `PMK_SERVICE` env, missing → standalone.
- launchd states: `installedPlist()` true iff plist exists; `loadedService()`
  reflects `launchctl print` success (mock); the lifecycle decision picks
  `kickstart` when loaded vs `bootstrap` when plist-exists-but-unloaded vs
  standalone when no plist.
- launchctl shell-free: `execFile("launchctl", [...])` exact argv (`bootout` /
  `kickstart -k` / `bootstrap`, `gui/<uid>/<label|plist>`); bad label rejected.
- stop: standalone (mock `process.kill` → SIGTERM then exit poll); launchctl
  path → `bootout` argv; not-running-and-not-installed message.
- restart: **plist-exists-but-unloaded → `bootstrap` (NOT `kickstart`)**;
  loaded → `kickstart -k`; standalone — assert detached spawn opts + stdio wired
  to the log fds (NOT "ignore"); **success reported ONLY after `phase:"ready"`
  from the new pid — a run-state that is still `"starting"` (early heartbeat/pid)
  must NOT count as success**; a child that dies / never reaches ready →
  failure message pointing at `gateway.err.log`.
- `adminDoctor`: the **provider is read at command time** — call `/doctor` twice
  with a snapshot that changes between calls and assert the second reflects the
  new state (proves no construction-time freeze). Verdict 🟢 (connected/0-flaps/
  fresh) vs 🟡 (reconnecting or flaps>0 or aging); missing provider → "unknown";
  non-admin → denied.
- verdict helper: with `live` → 🟢/🟡/🔴 per rules; **without `live` → never 🟢,
  caps at 🟡 when up, 🔴 when down**.
- CLI status: heartbeat + events with a dead pid → persisted health + the "use
  Slack doctor" note + **caps at 🟡 (never 🟢)**; **a gateway.json with a `{cmd}`
  secret ref → status does NOT execute the command** (sentinel cmd that would
  error/observe); fresh/aging/stale → right verdict.
- install-service: plist content (Label, KeepAlive, `PMK_SERVICE` env, abs paths,
  WorkingDirectory rule, **no secret**); `{env}`-secret warning fires; idempotency
  (`--force`); non-macOS guard.

## Deliverables

- `gateway/index.ts`: `GatewayRunState` (with `phase`), `readGatewayRunStateRaw()`,
  `gatewayLiveRunState()`, `installedPlist()`, `loadedService(label)`; in
  `runGateway` write `phase:"starting"` at start then rewrite `phase:"ready"`
  after `SlackAdapter.start()` resolves (capturing `PMK_SERVICE`/`PMK_SERVICE_LABEL`).
  `gatewayRunningPid()` derives from `gatewayLiveRunState()`.
- `gateway/socket-health.ts`: `SocketHealth.snapshot(now)`;
  `gateway/slack/socket-watchdog.ts`: `SocketWatchdog.snapshot()` (public reads).
- `commands/gateway/ops.ts`: `stopCmd`, `restartCmd` (supervised-decision +
  shell-free launchctl + detached logging/poll), enhanced `statusCmd` (raw
  run-state + `loadRawGatewayConfig`, never resolves secrets);
  `commands/gateway/index.ts`: `stop` / `restart` cases.
- `gateway/slack/admin.ts`: `adminDoctor` + `doctor` case; `slack/index.ts` +
  `slack/slash-command.ts`: thread a `getRuntimeHealthSnapshot()` **provider
  function** (closure over live `SocketHealth`/`SocketWatchdog` + `startedAt`,
  read at command time) into the admin handler.
- `commands/gateway/service.ts` (new): `installServiceCmd` + `install-service`
  case; launchd plist generator (WorkingDirectory rule, `{env}`-secret warning,
  shell-free launchctl, `--load`/`--uninstall`/`--force`).
- A small shared `verdict({ pidAlive, heartbeatAge, live? })` helper (🟢/🟡/🔴 +
  heartbeat fresh/aging/stale thresholds; `live` optional → CLI caps at 🟡) used
  by both Slack and CLI so the logic isn't duplicated.
- Docs: gateway onboarding/lifecycle page — "Operating the gateway" section
  (stop/restart, doctor, install-service, always-on).
- Tests for each unit above.

## Out of scope / future

- pm2 / systemd installers.
- Slack-initiated restart.
- A push alert when `/doctor` would be 🔴 (v0.19 watchdog DM already covers the
  hard-down case).
