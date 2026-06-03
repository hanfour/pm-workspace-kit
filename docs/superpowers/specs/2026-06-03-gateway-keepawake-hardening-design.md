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

- On macOS (`process.platform === "darwin"`): spawn `caffeinate <flags> -w <gateway-pid>` where the `-w <pid>` ties the power assertion to the gateway's lifetime so it auto-releases if the gateway dies abnormally. `stop()` kills the child on clean shutdown.
- **Default flags `-is`** (prevent idle **system** sleep + system sleep on AC) — deliberately *not* `-dimsu`. `-d` would hold the **display** awake, a real battery/screen cost over a long-running gateway. `-is` targets the actual failure (system idle/sleep throttling the backgrounded process) without that cost. The full `-dimsu` set is the **empirically verified-working** escalation (the incident fix); it is available via override, not forced as the default.
- **Override:** `PMK_GATEWAY_CAFFEINATE_FLAGS` env lets the operator escalate (e.g. to `-dimsu`) if `-is` proves insufficient on their machine. `-w <pid>` is always appended by the code.
- On any other platform: no-op (returns a handle whose `stop()` does nothing).
- **Child handling:** spawn with `stdio: "ignore"` and `child.unref()` (the keep-awake child must not keep the event loop alive or inherit pipes); attach an `error` listener (async spawn failures — e.g. `caffeinate` missing — surface there, not as a throw) in addition to a try/catch around the spawn call.
- The spawn function is injectable (default `child_process.spawn`) so tests assert behaviour without spawning real processes.
- Failure-isolated: a spawn throw or async `error` logs a warning and continues — keep-awake is best-effort and must never prevent the gateway from starting.

### Unit B — `packages/cli/src/gateway/socket-health.ts`

A **pure** `SocketHealth` tracker — no I/O, no timers, no clock of its own (all times passed in).

- `recordPongTimeout(nowMs)` — appends a pong/ping-timeout timestamp.
- `recordConnState(state, nowMs)` — records connection-lifecycle transitions (`connecting` / `connected` / `disconnected` / `reconnecting`).
- `assess(nowMs) → "healthy" | "unhealthy"`:
  - **unhealthy** if ≥ `PONG_TIMEOUT_THRESHOLD` (N=3) pong-timeouts fall within the trailing `PONG_TIMEOUT_WINDOW_MS` (W=60s); **or**
  - the client has not been in a stable `connected` state for longer than `UNSTABLE_CONN_LIMIT_MS` (T=60s) (i.e. disconnect/reconnect churn or a never-completing connect).
  - otherwise **healthy**.
- `reset(nowMs)` — clears the rolling **evidence** (pong-timeout timestamps + conn-state history used by `assess`) after a forced reconnect, so post-reconnect health is judged on fresh evidence. This is distinct from the watchdog's **attempt counter** (see wiring): resetting evidence must NOT reset the attempt counter, or a flapping socket (reconnect → `hello` → pong-timeout 30–60 s later, repeat) would never escalate.
- `lastStableConnectedSince(nowMs) → number | null` — the timestamp since which the client has been continuously `connected` with **no** pong-timeout; `null` if not currently in such a stable stretch. Used to gate the attempt-counter reset on *sustained* health, not a momentary successful `start()`.
- Old timestamps outside the window are pruned in `assess`/`record` so memory stays bounded.

### Unit C — custom Socket-Mode logger

A thin logger injected into `new SocketModeClient({ …, logger })` that intercepts WARN lines matching the pong/ping-timeout text (`/pong wasn't received|ping wasn't received/i`) and calls `health.recordPongTimeout(now())`, while still forwarding all logs to the existing sink (preserving current stdout behaviour). This is how the pong-timeout signal — which the client surfaces only as a log line, not an event — reaches the tracker.

### Wiring — watchdog in `SlackAdapter` / `runGateway`

- **Connection-lifecycle:** the SDK's `SocketModeClient` emits state events `connecting` / `connected` / `reconnecting` / `disconnecting` / `disconnected` (NOT `reconnect` — the adapter's current `"reconnect"` listener at `slack/index.ts:253` is a dead listener and is corrected here). Register `health.recordConnState(state, now())` on each of those five.
- **Evaluation cadence:** evaluate on the existing 30s heartbeat cadence — reuse the heartbeat tick if `startHeartbeat` exposes an on-tick hook, otherwise a single dedicated `setInterval` at the same 30s period (no proliferation of timers either way). Each tick calls `health.assess(now())`.
- **Single-flight guard:** a reconnect-in-progress flag. The SDK auto-reconnects on its own, so a watchdog-triggered `disconnect()`/`start()` must not race the SDK's own reconnect nor a second heartbeat tick. While a watchdog reconnect is in flight, subsequent ticks skip the recovery branch.
- **Escalating recovery** on `unhealthy` (and not already reconnecting):
  1. **In-process reconnect** — set the in-flight flag, `await socket.disconnect()` then `await socket.start()` (rebuild the connection), `health.reset(now())`, **increment** the attempt counter, clear the flag. (`health.reset` clears rolling evidence; it does NOT touch the attempt counter.)
  2. If the attempt counter reaches `REUNHEALTHY_ATTEMPTS` (M=3) without an intervening sustained-stable reset, perform a **loud exit** (see Loud exit below).
- **Attempt-counter reset — gated on *sustained* stability, not a successful `start()`:** on each tick, if `health.lastStableConnectedSince(now())` shows ≥ `STABLE_CONNECTED_RESET_MS` (default 180_000 = 3 min) of continuous `connected` with no pong-timeout, reset the attempt counter to 0. A socket that flaps (reconnect succeeds, then pong-timeouts again within the window) never clears 3 minutes of stability, so it correctly marches to loud exit rather than resetting every cycle.
- All collaborators are injectable (socket, `now()` clock, `exit` fn, alert fn) so the escalation is unit-testable without a real socket or process exit.

### Loud exit (operator alert, not a stakeholder broadcast)

The watchdog failure is an **operator alert**, not a presence notice — it must NOT reuse `PresenceBroadcaster` (which fans out to DMs/channels active in the last 24 h — too noisy and it would leak internal ops state to stakeholders). On loud exit:

- append a `gateway.offline` event with `reason: "watchdog-unhealthy"`;
- **DM each admin in `cfg.admins`** via the Web API (`chat.postMessage` over HTTP works even when the WebSocket is dead) with a concise "gateway self-terminated: Socket-Mode unrecoverable after M reconnects" message;
- if `cfg.admins` is empty: terminal log + the offline event only — **no fallback** to recent users/channels;
- then `process.exit(1)` — a supervisor (if any) restarts; without one it is a visible, alerting failure.

(A dedicated `watchdogAlertChannelId` config for channel alerts is deferred — see Out of scope.)

## Thresholds (named constants, centralised)

| Constant | Default | Meaning |
|---|---|---|
| `PONG_TIMEOUT_WINDOW_MS` | 60_000 | rolling window for counting pong-timeouts |
| `PONG_TIMEOUT_THRESHOLD` | 3 | pong-timeouts within the window → unhealthy |
| `UNSTABLE_CONN_LIMIT_MS` | 60_000 | max time un-`connected` before unhealthy |
| `REUNHEALTHY_ATTEMPTS` | 3 | consecutive failed watchdog reconnects before loud exit |
| `STABLE_CONNECTED_RESET_MS` | 180_000 | continuous `connected` + no pong-timeout required to reset the attempt counter |

All live in one place near the watchdog wiring for easy tuning against real data. The default keep-awake flags (`-is`) and override env (`PMK_GATEWAY_CAFFEINATE_FLAGS`) live with the keep-awake unit.

## Error handling

- keep-awake spawn failure — both a synchronous throw and an async `error` event → warn + continue (never blocks start).
- watchdog reconnect throwing → counts as a failed attempt (advances toward exit), logged; the in-flight flag is cleared in a `finally` so a throwing reconnect can't wedge the single-flight guard.
- the loud-exit admin DM is best-effort: wrap each `chat.postMessage` in try/catch so a failed alert still proceeds to the offline event + exit (we never swallow it silently — log the alert failure). With no admins configured, the offline event + terminal log are the alert.
- `SocketHealth` is pure and total (never throws on input).

## Testing

- **`socket-health.test.ts`** (pure): pong-flood crosses threshold → unhealthy; isolated single timeout → healthy; sustained churn beyond `UNSTABLE_CONN_LIMIT_MS` → unhealthy; stable `connected` → healthy; `reset` clears prior evidence; `lastStableConnectedSince` returns `null` when a pong-timeout interrupts a connected stretch and a timestamp once continuously stable; window pruning bounds state.
- **`keep-awake.test.ts`**: injected fake spawn — on `darwin` spawns `caffeinate` with the default `-is` and `-w <pid>`; `PMK_GATEWAY_CAFFEINATE_FLAGS` override is honoured (e.g. `-dimsu`) with `-w <pid>` still appended; spawned with `stdio:"ignore"` + `unref()`; on non-darwin spawns nothing; `stop()` kills the child; a sync spawn throw AND an async `error` event are both swallowed (start still returns a handle).
- **watchdog wiring test**: injected socket + clock + exit + alert — `unhealthy` → reconnect; **flapping** (reconnect succeeds then pong-timeouts again before `STABLE_CONNECTED_RESET_MS`) reaches `M` and triggers loud exit (admin DM sent + offline event + `exit(1)`); a reconnect followed by ≥ `STABLE_CONNECTED_RESET_MS` of stable `connected` resets the attempt counter (no exit); empty `cfg.admins` → offline event + exit, no broadcast; single-flight guard prevents a second tick from starting a concurrent reconnect.
- Full `@pmk/cli` suite stays green; new units keep the suite ≥ current 483.

## Out of scope / future

- launchd/systemd service + boot auto-start (separate follow-up if the process model ever changes).
- A dedicated `watchdogAlertChannelId` config for channel (vs admin-DM) operator alerts.
- Adaptive thresholds / telemetry on watchdog firings.
- Active health probes.
- A `pmk gateway doctor` check that warns when the gateway is running un-throttle-proofed (could be a small later addition).
