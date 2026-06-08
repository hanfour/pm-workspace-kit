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
  startedAt: number;        // ms epoch — drives uptime
  supervised: "launchd" | null;
  serviceLabel?: string;    // e.g. "com.pmk.gateway"
}
```

- Written by `runGateway` at startup; the file may persist after the process
  dies (so a dead daemon's last state is still readable) — see the raw/live
  split below. The existing shutdown marker stays as-is.
- `supervised` / `serviceLabel` (of the *running* process) are read from env at
  start: the launchd plist sets `PMK_SERVICE=launchd` + `PMK_SERVICE_LABEL=<label>`.
  Absent → `null` (standalone).

**Two readers (don't conflate):**
- `readGatewayRunStateRaw(): GatewayRunState | undefined` — the file as-is,
  possibly stale (pid may be dead). Used by `status` (must work when down).
- `gatewayLiveRunState(): GatewayRunState | undefined` — raw + liveness-checked
  via `process.kill(pid, 0)`; `undefined` if not actually running. Used by
  start/stop/restart. `gatewayRunningPid()` derives from this.

**Installed-service discovery (separate from "is it running"):** because after
`launchctl bootout` the daemon is gone and run-state is stale, env alone can't
tell start/restart whether a LaunchAgent is *installed*. Add
`installedService(): { label: string } | undefined` that checks the plist at
`~/Library/LaunchAgents/com.pmk.gateway.plist` (and, when present, confirms with
`launchctl print gui/<uid>/<label>`). So the supervised decision is:
*running supervised* (live run-state `supervised==="launchd"`) **or** *stopped
but installed* (`installedService()` present) → use launchctl; else standalone.

### Unit A — `stop` / `restart`

Add `case "stop"` / `case "restart"` to `commands/gateway/index.ts` and
`stopCmd` / `restartCmd` in `commands/gateway/ops.ts`. Both use the **supervised
decision** from Unit 0 (running-supervised OR stopped-but-installed → launchctl;
else standalone).

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
- launchctl path → `execFile("launchctl", ["kickstart", "-k",
  "gui/<uid>/<label>"])` (one-shot kill + restart). Report.
- standalone → run the stop path (SIGTERM + wait for exit), then re-launch
  detached: `spawn(<node>, [<dist>/index.js, "gateway", "start"], { detached:
  true, stdio: ["ignore", <out fd>, <err fd>] })`, `child.unref()`. **stdout/err
  go to the same log files as the LaunchAgent** (`~/.pmk/logs/gateway.{out,err}.log`,
  opened with `fs.openSync(..., "a")`) — NOT `"ignore"` — so a failed start is
  diagnosable. Then **poll run-state + heartbeat for up to ~8s**: only report
  success once a fresh run-state/heartbeat from the new pid appears; otherwise
  report "start may have failed — see ~/.pmk/logs/gateway.err.log" and the exit
  if the child already died.
- Not running → just start (detached standalone, same logging+poll) or
  `launchctl kickstart` (if installed).

If `launchctl` is missing / not macOS, fall back to the standalone path or
report a clear error.

### Unit B — `/doctor` runtime health (two surfaces, divided)

**Slack `/pmk admin doctor`** — live, from the daemon's in-memory state.
Add `adminDoctor` + `case "doctor"` in `slack/admin.ts`. **Main engineering
point:** `adminStatus` only `loadRawGatewayConfig()`s today; `adminDoctor`
needs the daemon's live handles. Their state is private, so add **public
snapshot APIs** and pass the snapshots (not the objects) into the handler:
- `SocketHealth.snapshot(now: number): { state, pongTimeoutsInWindow, unstableMs }`
- `SocketWatchdog.snapshot(): { flaps, reconnects, confirmedFailures }`

Thread these snapshots (+ `startedAt`) from `SlackAdapter` (`slack/index.ts`,
which owns the socket + health/watchdog) into `SlashCommandHandler` → the admin
handler (DI). When a handle is absent (e.g. dry-run) the metric renders
"unknown" rather than throwing.

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

Both lead with a one-line verdict: **🟢 healthy / 🟡 degraded / 🔴 down**:
- 🔴 down = pid dead OR heartbeat `stale`.
- 🟡 degraded = socket not `connected`, OR watchdog `flaps > 0`, OR heartbeat
  `aging`.
- 🟢 healthy = pid alive, socket connected, no flaps, heartbeat `fresh`.

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

- run-state: write on start; `readGatewayRunStateRaw` returns a stale file
  (dead pid) verbatim; `gatewayLiveRunState` returns undefined for a dead pid;
  `supervised` derived from `PMK_SERVICE` env, missing → standalone.
- installed-service discovery: `installedService()` true when the plist exists,
  undefined otherwise; "stopped but installed" → stop/restart take the launchctl
  path even though run-state is stale/absent.
- supervised decision: shell-free `execFile("launchctl", [...])` with the exact
  argv (`bootout` / `kickstart -k`, `gui/<uid>/<label>`); label validation rejects
  a bad label.
- stop: standalone (mock `process.kill` → SIGTERM then exit poll); launchctl path
  (asserts argv); not-running-and-not-installed message.
- restart: standalone — assert detached spawn opts, stdio wired to the log fds
  (NOT "ignore"), and that success is only reported after a fresh run-state/
  heartbeat appears within the poll window; a child that dies immediately →
  failure message pointing at `gateway.err.log`. launchctl path → `kickstart -k`.
- `adminDoctor`: inject fake `SocketHealth.snapshot`/`SocketWatchdog.snapshot`
  (connected/0-flaps vs reconnecting/N-flaps) + heartbeat + events → asserts
  verdict (🟢/🟡) and metric lines; missing handle → "unknown"; non-admin → denied.
- CLI status: heartbeat + events files with a dead pid → renders persisted health
  + the "use Slack doctor" note; **a gateway.json with a `{cmd}` secret ref →
  status does NOT execute the command** (assert via a sentinel cmd that would
  error/observe); heartbeat thresholds fresh/aging/stale map to the right verdict.
- install-service: plist content (Label, KeepAlive, `PMK_SERVICE` env, abs paths,
  WorkingDirectory rule, **no secret**); `{env}`-secret warning fires; idempotency
  (`--force`); non-macOS guard.

## Deliverables

- `gateway/index.ts`: `GatewayRunState`, `readGatewayRunStateRaw()`,
  `gatewayLiveRunState()`, `installedService()`; write run-state in `runGateway`
  (capturing `PMK_SERVICE`/`PMK_SERVICE_LABEL`). `gatewayRunningPid()` derives
  from `gatewayLiveRunState()`.
- `gateway/socket-health.ts`: `SocketHealth.snapshot(now)`;
  `gateway/slack/socket-watchdog.ts`: `SocketWatchdog.snapshot()` (public reads).
- `commands/gateway/ops.ts`: `stopCmd`, `restartCmd` (supervised-decision +
  shell-free launchctl + detached logging/poll), enhanced `statusCmd` (raw
  run-state + `loadRawGatewayConfig`, never resolves secrets);
  `commands/gateway/index.ts`: `stop` / `restart` cases.
- `gateway/slack/admin.ts`: `adminDoctor` + `doctor` case; `slack/index.ts` +
  `slack/slash-command.ts`: thread the `SocketHealth`/`SocketWatchdog` snapshots
  + `startedAt` into the admin handler.
- `commands/gateway/service.ts` (new): `installServiceCmd` + `install-service`
  case; launchd plist generator (WorkingDirectory rule, `{env}`-secret warning,
  shell-free launchctl, `--load`/`--uninstall`/`--force`).
- A small shared health-verdict helper (🟢/🟡/🔴 + heartbeat fresh/aging/stale
  thresholds) used by both Slack and CLI so the logic isn't duplicated.
- Docs: gateway onboarding/lifecycle page — "Operating the gateway" section
  (stop/restart, doctor, install-service, always-on).
- Tests for each unit above.

## Out of scope / future

- pm2 / systemd installers.
- Slack-initiated restart.
- A push alert when `/doctor` would be 🔴 (v0.19 watchdog DM already covers the
  hard-down case).
