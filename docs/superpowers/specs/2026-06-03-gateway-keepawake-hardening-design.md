# Gateway keep-awake hardening — design

**Date:** 2026-06-03
**Status:** Approved (design); implementation pending
**Source:** Reliability follow-up from the v0.18.0 demo smoke. A backgrounded gateway daemon was App-Nap/sleep-throttled on macOS, starving Slack Socket-Mode's ping/pong (5s window); the socket reconnected endlessly (`SlackWebSocket:N` incrementing) but never stayed healthy → a **silent multi-day outage** with the process alive and the heartbeat ticking. See memory `feedback-gateway-socket-stale-no-reconnect`.

## Context

`runGateway` is **foreground only — no daemonisation** (`packages/cli/src/gateway/index.ts:35`); the host is expected to run it in a persistent terminal / tmux pane. pmk ships **no** keep-awake of its own (the `caffeinate -i -t 300` seen during the incident was an unrelated system process, not pmk). In practice the gateway gets backgrounded (`nohup … & disown`), where macOS App Nap / idle-sleep throttles the process so node's timers can't service Slack's ping/pong inside the 5s window → every fresh socket is judged dead and torn down → no inbound events → the bot answers no one. A `caffeinate -dimsu` wrapper empirically fixed it (0 pong-timeouts over minutes vs constant failures).

Two defences, decided during brainstorming:

1. **Throttle-proofing** — `pmk gateway start` holds a macOS power assertion for its own lifetime, so the Socket-Mode connection can't be starved however the process is launched.
2. **Self-heal watchdog** — observe the Socket-Mode client's health and, when it goes unhealthy, escalate: force an in-process reconnect, and if that repeatedly fails, exit loudly (and alert) rather than sit as a silent zombie.

## Goals

- A backgrounded `pmk gateway start` on macOS stays throttle-free for its whole lifetime, with zero extra operator setup.
- A wedged Socket-Mode connection (from any cause: network blip, Slack-side drop, edge-case throttle) is detected and self-healed by an in-process reconnect.
- An unrecoverable socket becomes a **loud, alerting** failure (Web-API alert + non-zero exit), never a silent zombie — directly closing the gap that made the original incident invisible.
- All new logic is in small, focused, unit-testable units.

## Non-goals (YAGNI)

- No launchd / systemd / system-service install (the process model is retained, per the brainstorming decision).
- No boot auto-start.
- No active HTTP probing to infer socket health (probing the HTTP path doesn't prove the WebSocket is delivering).
- No adaptive/auto-tuned thresholds — fixed named constants, tunable later from real data.
- No change to the foreground run model or to how the operator launches the gateway.

## Architecture

Three new small units plus watchdog wiring in the existing `SlackAdapter` / `runGateway`. Non-macOS platforms are a no-op for keep-awake; the watchdog is platform-agnostic.

### Unit A — `packages/cli/src/gateway/keep-awake.ts`

`startKeepAwake(deps?) → handle` / `handle.stop()`.

- On macOS (`process.platform === "darwin"`): spawn `caffeinate -dimsu -w <gateway-pid>` detached; the `-w <pid>` ties the power assertion to the gateway's lifetime so it auto-releases if the gateway dies abnormally. `stop()` kills the child on clean shutdown.
- On any other platform: no-op (returns a handle whose `stop()` does nothing).
- The spawn function is injectable (default `child_process.spawn`) so tests assert behaviour without spawning real processes.
- Failure-isolated: if the spawn throws, log a warning and continue — keep-awake is best-effort and must never prevent the gateway from starting.

### Unit B — `packages/cli/src/gateway/socket-health.ts`

A **pure** `SocketHealth` tracker — no I/O, no timers, no clock of its own (all times passed in).

- `recordPongTimeout(nowMs)` — appends a pong/ping-timeout timestamp.
- `recordConnState(state, nowMs)` — records connection-lifecycle transitions (`connecting` / `connected` / `disconnected` / `reconnecting`).
- `assess(nowMs) → "healthy" | "unhealthy"`:
  - **unhealthy** if ≥ `PONG_TIMEOUT_THRESHOLD` (N=3) pong-timeouts fall within the trailing `PONG_TIMEOUT_WINDOW_MS` (W=60s); **or**
  - the client has not been in a stable `connected` state for longer than `UNSTABLE_CONN_LIMIT_MS` (T=60s) (i.e. disconnect/reconnect churn or a never-completing connect).
  - otherwise **healthy**.
- `reset(nowMs)` — clears the rolling state after a successful forced reconnect, so post-reconnect health is judged on fresh evidence.
- Old timestamps outside the window are pruned in `assess`/`record` so memory stays bounded.

### Unit C — custom Socket-Mode logger

A thin logger injected into `new SocketModeClient({ …, logger })` that intercepts WARN lines matching the pong/ping-timeout text (`/pong wasn't received|ping wasn't received/i`) and calls `health.recordPongTimeout(now())`, while still forwarding all logs to the existing sink (preserving current stdout behaviour). This is how the pong-timeout signal — which the client surfaces only as a log line, not an event — reaches the tracker.

### Wiring — watchdog in `SlackAdapter` / `runGateway`

- Connection-lifecycle: the adapter already listens to `disconnected` / `reconnect`; extend these (and the `connected`/start path) to call `health.recordConnState(...)`.
- **Evaluation cadence:** evaluate on the existing 30s heartbeat cadence — reuse the heartbeat tick if `startHeartbeat` exposes an on-tick hook, otherwise a single dedicated `setInterval` at the same 30s period (no proliferation of timers either way). Each tick calls `health.assess(now())`.
- **Escalating recovery** on `unhealthy`:
  1. **In-process reconnect** — `await socket.disconnect()` then `await socket.start()` (rebuild the connection); `health.reset(now())`; increment a reconnect-attempt counter.
  2. If `REUNHEALTHY_ATTEMPTS` (M=3) consecutive watchdog-triggered reconnects fail to return the socket to `healthy`, perform a **loud exit**:
     - append a `gateway.offline` event with `reason: "watchdog-unhealthy"`;
     - send a watchdog **alert via the Web API** (`chat.postMessage`, which works over HTTP even when the WebSocket is dead) to the same admin/owner broadcast destination the gateway already uses for online/offline notices;
     - `process.exit(1)` — a supervisor (if any) restarts; without one it is a visible, alerting failure.
  - A reconnect that restores `healthy` resets the attempt counter (so isolated blips don't march toward exit).
- All collaborators are injectable (socket, `now()` clock, `exit` fn, broadcast fn) so the escalation is unit-testable without a real socket or process exit.

## Thresholds (named constants, centralised)

| Constant | Default | Meaning |
|---|---|---|
| `PONG_TIMEOUT_WINDOW_MS` | 60_000 | rolling window for counting pong-timeouts |
| `PONG_TIMEOUT_THRESHOLD` | 3 | pong-timeouts within the window → unhealthy |
| `UNSTABLE_CONN_LIMIT_MS` | 60_000 | max time un-`connected` before unhealthy |
| `REUNHEALTHY_ATTEMPTS` | 3 | consecutive failed watchdog reconnects before loud exit |

All live in one place near the watchdog wiring for easy tuning against real data.

## Error handling

- keep-awake spawn failure → warn + continue (never blocks start).
- watchdog reconnect throwing → counts as a failed attempt (advances toward exit), logged.
- the loud-exit alert is best-effort: wrap the `chat.postMessage` in try/catch so a failed alert still proceeds to the offline event + exit (we never swallow it silently — log the alert failure).
- `SocketHealth` is pure and total (never throws on input).

## Testing

- **`socket-health.test.ts`** (pure): pong-flood crosses threshold → unhealthy; isolated single timeout → healthy; sustained churn beyond `UNSTABLE_CONN_LIMIT_MS` → unhealthy; stable `connected` → healthy; `reset` clears prior evidence; window pruning bounds state.
- **`keep-awake.test.ts`**: injected fake spawn — on `darwin` spawns `caffeinate` with `-dimsu` and `-w <pid>`; on non-darwin spawns nothing; `stop()` kills the child; spawn throw is swallowed (start still returns a handle).
- **watchdog wiring test**: injected socket + clock + exit + broadcast — `unhealthy` → reconnect; after `M` failed reconnects → alert sent + offline event + `exit(1)`; a reconnect that restores health → no exit and counter reset.
- Full `@pmk/cli` suite stays green; new units keep the suite ≥ current 483.

## Out of scope / future

- launchd/systemd service + boot auto-start (separate follow-up if the process model ever changes).
- Adaptive thresholds / telemetry on watchdog firings.
- Active health probes.
- A `pmk gateway doctor` check that warns when the gateway is running un-throttle-proofed (could be a small later addition).
