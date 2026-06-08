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

- Written by `runGateway` at startup; removed/ignored on graceful shutdown
  (the existing shutdown marker stays as-is).
- `supervised` / `serviceLabel` are read from env at start: the launchd plist
  sets `PMK_SERVICE=launchd` + `PMK_SERVICE_LABEL=<label>`. Absent → `null`
  (standalone). **This env is the single detection mechanism shared by A and C.**
- New `gatewayRunState(): GatewayRunState | undefined` (liveness-checked via
  `process.kill(pid, 0)`); `gatewayRunningPid()` keeps working (derives from it).

### Unit A — `stop` / `restart`

Add `case "stop"` / `case "restart"` to `commands/gateway/index.ts` and
`stopCmd` / `restartCmd` in `commands/gateway/ops.ts`. Both branch on
`runState.supervised`.

**`pmk gateway stop`:**
- Not running → "gateway is not running." (no error)
- `supervised === "launchd"` → `launchctl bootout gui/<uid>/<label>`
  (plain SIGTERM would be respawned by KeepAlive). Report success/failure.
- standalone → `process.kill(pid, "SIGTERM")` (existing graceful path: 25s
  drain + offline broadcast + marker), then poll `process.kill(pid,0)` until it
  exits (cap ~30s) and report graceful stop; on timeout, report still-running.

**`pmk gateway restart`:**
- `supervised === "launchd"` → `launchctl kickstart -k gui/<uid>/<label>`
  (one-shot kill + restart). Report.
- standalone → run the stop path (SIGTERM + wait for exit), then **re-launch
  detached**: spawn `pmk gateway start` with `{ detached: true, stdio:
  "ignore" }` (so the new daemon survives the restart command exiting) wrapped
  by the existing keep-awake; report the new pid. (Necessary because `start`
  blocks in the foreground.)
- Not running → just start (detached, standalone) or `launchctl kickstart`
  (supervised, if the service is installed).

`<uid>` = `process.getuid()`. If `launchctl` is missing / not macOS, fall back
to the standalone path or report a clear error.

### Unit B — `/doctor` runtime health (two surfaces, divided)

**Slack `/pmk admin doctor`** — live, from the daemon's in-memory state.
Add `adminDoctor` + `case "doctor"` in `slack/admin.ts`. **Main engineering
point:** `adminStatus` only `loadRawGatewayConfig()`s today; `adminDoctor`
needs the daemon's live handles, so thread `SocketHealth` + `SocketWatchdog`
(+ `startedAt`) from `SlackAdapter` (`slack/index.ts`, which already owns the
socket + health/watchdog) into `SlashCommandHandler` → the admin handler (DI).

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
Reports from files/events, no daemon memory:
| metric | source |
|---|---|
| pid alive? | `process.kill(pid,0)` |
| supervised? + label | run-state |
| heartbeat age (fresh/stale vs `HEARTBEAT_STALE_MS=60s`) | heartbeat file |
| last online/offline + reason | events |
| turns served last 30m | events `turn.processed` |
| uptime | run-state `startedAt` |
| live socket state | **N/A** — print "use Slack `/pmk admin doctor` for live socket" |

Both lead with a one-line verdict: **🟢 healthy / 🟡 degraded / 🔴 down**
(rules: down = pid dead or heartbeat stale; degraded = socket not connected,
or watchdog flaps > 0, or heartbeat aging; else healthy). Permission: Slack
side gated by the existing `/pmk admin` admin check; CLI runs on the host.

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
  - `WorkingDirectory`, `ProcessType=Background`
- Prints the `launchctl bootstrap gui/<uid> <plist>` + `launchctl enable` steps;
  with `--load`, runs them.
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

- run-state: write on start; read + liveness; `supervised` derived from
  `PMK_SERVICE` env; missing env → standalone.
- stop: standalone (mock `process.kill` → SIGTERM then exit poll); supervised
  (asserts the `launchctl bootout gui/<uid>/com.pmk.gateway` command, mock exec);
  not-running message.
- restart: standalone (stop, then detached `start` spawn — assert detached opts);
  supervised (`launchctl kickstart -k …`); not-running → start.
- `adminDoctor`: inject fake `SocketHealth` (connected vs reconnecting) +
  `SocketWatchdog` (0 vs N flaps) + heartbeat + events → asserts verdict
  (healthy/degraded) and metric lines; non-admin actor → denied.
- CLI status: from heartbeat + events files with a dead pid → still renders
  persisted health + the "use Slack doctor for live socket" note.
- install-service: plist content (Label, KeepAlive, `PMK_SERVICE` env, abs paths,
  **no secret**); idempotency (`--force`); non-macOS guard.

## Deliverables

- `gateway/index.ts`: `GatewayRunState`, `gatewayRunState()`, write run-state in
  `runGateway` (with `PMK_SERVICE`/`PMK_SERVICE_LABEL` capture).
- `commands/gateway/ops.ts`: `stopCmd`, `restartCmd`, enhanced `statusCmd`;
  `commands/gateway/index.ts`: `stop` / `restart` cases.
- `gateway/slack/admin.ts`: `adminDoctor` + `doctor` case; `slack/index.ts` +
  `slack/slash-command.ts`: thread `SocketHealth`/`SocketWatchdog`/`startedAt`
  into the admin handler.
- `commands/gateway/ops.ts` (or a new `commands/gateway/service.ts`):
  `installServiceCmd` + `install-service` case; launchd plist generator.
- A small shared health-verdict helper (used by both Slack and CLI) so the
  🟢/🟡/🔴 logic isn't duplicated.
- Docs: gateway onboarding/lifecycle page — "Operating the gateway" section
  (stop/restart, doctor, install-service, always-on).
- Tests for each unit above.

## Out of scope / future

- pm2 / systemd installers.
- Slack-initiated restart.
- A push alert when `/doctor` would be 🔴 (v0.19 watchdog DM already covers the
  hard-down case).
