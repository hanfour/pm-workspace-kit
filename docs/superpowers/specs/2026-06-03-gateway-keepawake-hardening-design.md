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
- **Child handling:** spawn with `stdio: "ignore"` and `child.unref()` (the keep-awake child must not keep the event loop alive or inherit pipes). Cover all three failure shapes: a try/catch around the spawn call (sync throw), an `error` listener (async spawn failure — e.g. `caffeinate` missing), **and** an `exit`/`close` listener — invalid flags or `caffeinate` self-exiting usually surface as a non-zero exit, not an `error`. If the child exits while the gateway did NOT intentionally `stop()` it, log a warning (keep-awake has silently dropped, leaving the process unprotected) rather than letting it vanish unnoticed.
- The spawn function is injectable (default `child_process.spawn`) so tests assert behaviour without spawning real processes.
- Failure-isolated: a spawn throw or async `error` logs a warning and continues — keep-awake is best-effort and must never prevent the gateway from starting.

### Unit B — `packages/cli/src/gateway/socket-health.ts`

A **pure** `SocketHealth` tracker — no I/O, no timers, no clock of its own (all times passed in).

- `recordPongTimeout(nowMs)` — appends a pong/ping-timeout timestamp.
- `recordConnState(state, nowMs)` — records connection-lifecycle transitions. `state` is one of the five SDK states `connecting` / `connected` / `reconnecting` / `disconnecting` / `disconnected` (matches the wiring + the SDK `State` enum).
- `assess(nowMs) → "healthy" | "unhealthy"`:
  - **unhealthy** if ≥ `PONG_TIMEOUT_THRESHOLD` (N=3) pong-timeouts fall within the trailing `PONG_TIMEOUT_WINDOW_MS` (W=60s); **or**
  - the client has not been in a stable `connected` state for longer than `UNSTABLE_CONN_LIMIT_MS` (T=60s) (i.e. disconnect/reconnect churn or a never-completing connect).
  - otherwise **healthy**.
- `reset(nowMs)` — clears **only the pong-timeout evidence** (the rolling pong-timeout timestamps), so the pong-flood window starts fresh after a forced reconnect. It must **NOT** clear the connection-state machine — that is event-driven and, right after a successful `socket.start()`, already holds the fresh `connected`-since anchor that `lastStableConnectedSince` needs. Wiping it would leave `lastStableConnectedSince` without a start point and could misjudge a healthy socket as unstable. (Reset is also distinct from the watchdog's **failed-reconnect counter**, which lives in the wiring and is never touched here — see Wiring.)
- `lastStableConnectedSince(nowMs) → number | null` — **null iff the client is not *currently* in the `connected` state**. When connected, it returns the later of {the timestamp it entered `connected`, the most recent pong-timeout timestamp}. So a non-`connected` state nulls it (the stretch is broken), while a pong-timeout *while connected* does **not** null it — it merely **restarts** the stable clock from the timeout instant. After `reset` has cleared pong-timeouts, the value is simply the `connected`-since timestamp. (Note: the pong-flood that would make `assess` unhealthy is handled separately; this method only gates the sustained-stability attempt reset, so a single occasional timeout correctly delays — not voids — the reset.)
- Old timestamps outside the window are pruned in `assess`/`record` so memory stays bounded.

### Unit C — custom Socket-Mode logger

A thin logger injected into `new SocketModeClient({ …, logger })` that intercepts WARN lines matching the pong/ping-timeout text (`/pong wasn't received|ping wasn't received/i`) and calls `health.recordPongTimeout(now())`, while still forwarding all logs to the existing sink (preserving current stdout behaviour). This is how the pong-timeout signal — which the client surfaces only as a log line, not an event — reaches the tracker.

### Wiring — watchdog in `SlackAdapter` / `runGateway`

- **Connection-lifecycle:** the SDK's `SocketModeClient` emits state events `connecting` / `connected` / `reconnecting` / `disconnecting` / `disconnected` (NOT `reconnect` — the adapter's current `"reconnect"` listener at `slack/index.ts:253` is a dead listener and is corrected here). Register `health.recordConnState(state, now())` on each of those five.
- **Evaluation cadence:** evaluate on the existing 30s heartbeat cadence — reuse the heartbeat tick if `startHeartbeat` exposes an on-tick hook, otherwise a single dedicated `setInterval` at the same 30s period (no proliferation of timers either way). Each tick calls `health.assess(now())`.
- **Single-flight guard — only the watchdog's *own* reconnect.** The flag (`watchdogReconnectInFlight`) is set strictly while the watchdog's own `disconnect()`→`start()` is awaiting, so two heartbeat ticks can't launch concurrent reconnects. It must **NOT** be conflated with the SDK's auto-reconnect: a tick where the SDK is merely in `connecting`/`reconnecting` is **not** skipped. That is exactly the incident's mode (the SDK reconnects forever but never gets healthy) — `assess` already flags it unhealthy via `UNSTABLE_CONN_LIMIT_MS` (the SDK's own reconnect effectively gets that window as grace), after which the watchdog takes over with a force `disconnect()`/`start()`.

- **Watchdog state (in the wiring):** `failedReconnects` counter + `watchdogReconnectInFlight` flag + `pendingEvaluation` flag (a watchdog reconnect completed and is awaiting its stability verdict).

- **Per-tick logic** (after `health.assess(now())`):
  - **healthy** → if `lastStableConnectedSince(now())` is non-null and `now − it ≥ STABLE_CONNECTED_RESET_MS` (3 min), the last reconnect *succeeded*: set `failedReconnects = 0`, clear `pendingEvaluation`. Otherwise do nothing (still proving stability). Never exits on a healthy tick.
  - **unhealthy** and `watchdogReconnectInFlight` → skip (our reconnect is mid-flight).
  - **unhealthy** otherwise:
    1. If `pendingEvaluation` (a prior watchdog reconnect went unhealthy again before reaching 3 min stable) → that reconnect **failed**: `failedReconnects += 1`, clear `pendingEvaluation`.
    2. If `failedReconnects ≥ REUNHEALTHY_ATTEMPTS` (M=3) → **loud exit** (see below). Exit therefore happens on an *unhealthy* tick after M confirmed failures — never immediately after a `start()` that just succeeded.
    3. Else → **force reconnect**: set in-flight, then run `socket.disconnect()` followed by `socket.start()` **each raced against a `WATCHDOG_RECONNECT_TIMEOUT_MS` (45 s) timeout**, clearing in-flight in a `finally`.
       - **Why the timeout is mandatory:** `SocketModeClient.disconnect()` resolves only after the `disconnected` event and `start()` only after `connected`/`disconnected`; when the socket is truly wedged or the SDK's own auto-reconnect is stuck, neither may ever settle. Without the timeout, `watchdogReconnectInFlight` would stay `true` forever, every later tick would skip recovery, and we'd be back to a silent zombie — the exact failure this watchdog exists to kill.
       - On **success** (both steps settle in time): `health.reset(now())`, set `pendingEvaluation`.
       - On **either step timing out OR throwing**: it counts as an **immediate failed reconnect** (`failedReconnects += 1`, `pendingEvaluation` cleared, logged). If that reaches M, the next unhealthy tick performs the loud exit.
- All collaborators are injectable (socket, `now()` clock, `exit` fn, alert fn) so the escalation is unit-testable without a real socket or process exit.

### Loud exit (operator alert, not a stakeholder broadcast)

The watchdog failure is an **operator alert**, not a presence notice — it must NOT reuse `PresenceBroadcaster` (which fans out to DMs/channels active in the last 24 h — too noisy and it would leak internal ops state to stakeholders). On loud exit:

- **Emit the `gateway.offline` event through the `PresenceBroadcaster`, not by hand** — the event shape is `{ type, seq, reason, broadcast, offlineDurationMs? }` (`events.ts`) and `seq` is the broadcaster's monotonic per-process counter. The watchdog calls the broadcaster to record the transition with `reason: "watchdog-unhealthy"` and **`broadcast: false`** (this is an operator alert, not a stakeholder fan-out). Since the existing `offline()` always fans out, this needs a small broadcaster method that records the event with `broadcast:false` and skips the fan-out (or an explicit flag on `offline()`); the watchdog must NOT `appendGatewayEvent` a partial shape itself.
- **DM each admin in `cfg.admins`** — a bot **cannot** `chat.postMessage` straight to a `U…` user id; first `conversations.open({ users: adminId })` to get the DM channel id, then `chat.postMessage({ channel: dmId, text })` (HTTP works even when the WebSocket is dead). Message: a concise "pmk gateway self-terminated: Socket-Mode unrecoverable after `M` reconnect attempts; restart needed." Each admin's open+post is wrapped in try/catch and logged on failure.
- if `cfg.admins` is empty: terminal log + the offline event only — **no fallback** to recent users/channels;
- then `process.exit(1)` — a supervisor (if any) restarts; without one it is a visible, alerting failure.

(A dedicated `watchdogAlertChannelId` config for channel alerts is deferred — see Out of scope.)

## Thresholds (named constants, centralised)

| Constant | Default | Meaning |
|---|---|---|
| `PONG_TIMEOUT_WINDOW_MS` | 60_000 | rolling window for counting pong-timeouts |
| `PONG_TIMEOUT_THRESHOLD` | 3 | pong-timeouts within the window → unhealthy |
| `UNSTABLE_CONN_LIMIT_MS` | 60_000 | max time un-`connected` before unhealthy |
| `REUNHEALTHY_ATTEMPTS` | 3 | confirmed-failed reconnects (each went unhealthy again before `STABLE_CONNECTED_RESET_MS`, or its `start()` threw) before loud exit on the next unhealthy tick |
| `STABLE_CONNECTED_RESET_MS` | 180_000 | continuous `connected` + no pong-timeout required to reset the attempt counter |
| `WATCHDOG_RECONNECT_TIMEOUT_MS` | 45_000 | per-step cap on a forced `disconnect()`/`start()`; timing out = a failed reconnect (prevents a wedged reconnect from pinning the in-flight flag) |

All live in one place near the watchdog wiring for easy tuning against real data. The default keep-awake flags (`-is`) and override env (`PMK_GATEWAY_CAFFEINATE_FLAGS`) live with the keep-awake unit.

## Error handling

- keep-awake spawn failure — both a synchronous throw and an async `error` event → warn + continue (never blocks start).
- watchdog reconnect **throwing or timing out** (`WATCHDOG_RECONNECT_TIMEOUT_MS`) → counts as a failed reconnect (advances toward exit), logged; the in-flight flag is cleared in a `finally` so neither a throwing nor a never-settling reconnect can wedge the single-flight guard.
- the loud-exit admin DM is best-effort: wrap each `chat.postMessage` in try/catch so a failed alert still proceeds to the offline event + exit (we never swallow it silently — log the alert failure). With no admins configured, the offline event + terminal log are the alert.
- `SocketHealth` is pure and total (never throws on input).

## Testing

- **`socket-health.test.ts`** (pure): pong-flood crosses threshold → unhealthy; isolated single timeout → healthy; sustained churn beyond `UNSTABLE_CONN_LIMIT_MS` → unhealthy; stable `connected` → healthy; `reset` clears pong-timeout evidence but leaves the conn-state machine intact (a `connected` anchor set before `reset` survives it); `lastStableConnectedSince` is `null` only when not `connected`, returns `max(connectedSince, lastPongTimeoutAt)` when connected (a single pong-timeout while connected *restarts* the clock rather than nulling it); window pruning bounds state.
- **`keep-awake.test.ts`**: injected fake spawn — on `darwin` spawns `caffeinate` with the default `-is` and `-w <pid>`; `PMK_GATEWAY_CAFFEINATE_FLAGS` override is honoured (e.g. `-dimsu`) with `-w <pid>` still appended; spawned with `stdio:"ignore"` + `unref()`; on non-darwin spawns nothing; `stop()` kills the child; all three failure shapes are swallowed-with-warning (sync spawn throw, async `error`, and an unexpected child `exit`/`close` while not intentionally stopped) and `start` still returns a handle.
- **watchdog wiring test**: injected socket + clock + exit + alert —
  - `unhealthy` → one force reconnect (sets/clears in-flight);
  - **successful recovery**: reconnect, then ≥ `STABLE_CONNECTED_RESET_MS` of stable `connected` → `failedReconnects` resets to 0, no exit;
  - **flapping**: reconnect succeeds then goes unhealthy again before 3 min, repeated → counts 3 confirmed failures → loud exit on the next unhealthy tick (admin DM sent + offline event + `exit(1)`), and crucially **does not** exit on the tick where a `start()` had just succeeded;
  - **`start()` throw** → immediate failed reconnect; three such → loud exit;
  - **reconnect timeout**: a `disconnect()`/`start()` whose promise never settles is cut off at `WATCHDOG_RECONNECT_TIMEOUT_MS`, counts as a failed reconnect, **clears the in-flight flag** (a later tick is not skipped), and three such → loud exit — i.e. a wedged reconnect cannot pin the guard and silently zombie;
  - **SDK churn**: client stuck `reconnecting` past `UNSTABLE_CONN_LIMIT_MS` is assessed unhealthy and the watchdog force-acts (not skipped);
  - **loud-exit wiring**: the `gateway.offline` event is recorded via the presence broadcaster with `reason:"watchdog-unhealthy"` + `broadcast:false` (proper `seq`, no stakeholder fan-out), and each admin alert goes `conversations.open` → `chat.postMessage` to the DM channel;
  - empty `cfg.admins` → offline event + terminal log + exit, no admin DMs and no broadcast;
  - single-flight guard prevents a second tick from starting a concurrent reconnect while one is in flight.
- Full `@pmk/cli` suite stays green; new units keep the suite ≥ current 483.

## Out of scope / future

- launchd/systemd service + boot auto-start (separate follow-up if the process model ever changes).
- A dedicated `watchdogAlertChannelId` config for channel (vs admin-DM) operator alerts.
- Adaptive thresholds / telemetry on watchdog firings.
- Active health probes.
- A `pmk gateway doctor` check that warns when the gateway is running un-throttle-proofed (could be a small later addition).
