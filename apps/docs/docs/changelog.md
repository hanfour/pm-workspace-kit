---
sidebar_position: 99
---

# Changelog

All notable changes to **pm-workspace-kit** are documented here.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each release also has a longer narrative on [GitHub Releases](https://github.com/hanfour/pm-workspace-kit/releases) with rationale, dogfood notes, and test plans.

## [v0.13.2] — 2026-05-20 — gateway audience: re-flip default pm → biz

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.13.2)

### Why

v0.13.1 flipped `defaultAudience()` from `tech` → `pm` on the assumption that PM tier was the right "middle ground" for unknown / non-IT users. Live re-verification on a real workspace (2026-05-20, ~30 min after v0.13.1 shipped) showed the gap between `tech` and `pm` was too narrow for the actual product intent: PM tier still cites file paths (`app/models/ability.rb`), model names (`PlacementRevenue`), and method names — by design, because PM tier is for "PM who briefs engineers later". A true non-IT user (sales / ops / exec-adjacent) still got a code-flavoured reply with a stray Ruby block that the PM prompt's own "no code blocks unless quoting an exact API name or table column" rule was supposed to ban.

`biz` is the actual right default. The BIZ prompt forces jargon translation (`AdFormat` → 「廣告版型」, `scope` → 「篩選條件」, `AASM` → 「狀態機」), bans code blocks unless quoting operational SQL the user must run, and collapses implementation into "想看實作可以再問 IT". For the average pmk-gateway workspace this matches what the operator actually wants: non-IT stakeholders get plain-Chinese answers, IT/PM users opt in to the richer tiers explicitly.

### Fixed

- **`defaultAudience()` returns `{ default: "biz" }`** (`packages/cli/src/gateway/config.ts`). Same factory-only effect as v0.13.1 — existing `gateway.json` files are not modified on upgrade. PMs and engineers opt in via per-user override:
  ```bash
  pmk gateway audience set <PM-USER-ID> pm
  pmk gateway audience set <IT-USER-ID> tech
  ```
- **Test assertion follows the factory** — same back-fill test in `gateway.test.ts` flipped from `default === "pm"` to `default === "biz"`; intent unchanged ("legacy configs back-fill with the default").

### Tests

`@pmk/cli` 362 → **362** (unchanged). All 412 workspace tests still pass.

### Operator note

If you're upgrading from v0.13.1 (or any earlier version) and want non-IT users to get BIZ-tier replies:

```bash
pmk gateway audience default biz
# Optionally add PM-aware users (will still get file/model refs they can forward):
pmk gateway audience set <PM-USER-ID> pm
# Restart gateway so the in-memory config snapshot updates:
kill -TERM $(cat ~/.pmk/gateway/gateway.pid) && pmk gateway start
```

The `pm` and `tech` tiers still exist and work — only the *default* changed.

---

## [v0.13.1] — 2026-05-20 — gateway audience: flip default tech → pm

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.13.1)

### Why

Same-day dogfood on v0.13.0 surfaced a product mismatch the audience-tier code has carried since v0.8.0: `defaultAudience()` returned `{ default: "tech" }`, so every unknown / unconfigured user got engineer-grade replies with file paths, API names, and `:`-separated module references. A test channel with a non-IT teammate (PM / ops) saw the bot answer "ability.rb 沒有全域 admin 角色" with file-line refs and a `dynamic dispatch` callout — accurate but unusable for the actual reader. The four prompts (`tech` / `pm` / `biz` / `exec`) already differentiate cleanly; the bug was that the **default flipped the wrong way** for a typical pmk-gateway workspace where most stakeholders are non-IT.

### Fixed

- **`defaultAudience()` returns `{ default: "pm" }`** ([`packages/cli/src/gateway/config.ts`](https://github.com/hanfour/pm-workspace-kit/blob/main/packages/cli/src/gateway/config.ts)). `pm` is the middle tier: structural findings without formulas, jargon translated (`AdFormat` → 「廣告版型」, `scope` → 「篩選條件」, `AASM` → 「狀態機」), PM-framed questions back to the user. IT users opt in via explicit per-user override (`/pmk admin audience set <@user> tech` or `pmk gateway audience set <userId> tech`).
- **Existing installs are unaffected on disk** — the factory only fires when `audience` is missing from `gateway.json`. Upgrading admins who want the new behaviour can either delete the `audience.default` line and reload, or run `pmk gateway audience default pm` to flip it explicitly.

### Tests

`@pmk/cli` 362 → **362** (unchanged). One existing back-fill assertion in `gateway.test.ts` flipped from `default === "tech"` to `default === "pm"` to match the new factory; the assertion's intent was always "legacy configs get back-filled with the default" — the specific value is what changed. All 412 workspace tests still pass.

### Operator note

If you've been running v0.13.0 (or any earlier version) and want non-IT users to get the new behaviour, run on the gateway host:

```bash
pmk gateway audience default pm
pmk gateway audience set <YOUR-IT-USER-ID> tech
# Then restart the gateway so the new config snapshot is in-memory:
# Ctrl+C the foreground process, or kill -TERM <pid>, then `pmk gateway start`.
```

The audience field is loaded into memory at adapter construction (the same in-memory snapshot caveat as `escalation`), so a config change requires a restart to bite.

---

## [v0.13.0] — 2026-05-20 — SlackGateway harness + adapter decomposition + FIFO inflight queue

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.13.0)

### Why

The v0.7 → v0.12 gateway picked up presence broadcast, per-channel audience, monthly audit logs, msg_too_long hardening, anthropic-api as default, token.usage rollups — all landed on a 1708-line `SlackAdapter` monolith with **zero automated coverage**. Every change in that series had to be verified by hand via live-Slack dogfood because instantiating the adapter required real Slack tokens and a live socket connection. Two problems compounded:

1. **No safety net for a refactor.** The adapter mixed Slack transport + session + LLM + mra-ask + escalation + atoms + reactions + presence + slash commands. Splitting it into focused modules — the only way to keep adding features without the file becoming write-only — was hostage to live verification per change.
2. **Two latent multi-user bugs were invisible.** Rapid follow-up messages from the same user were silently dropped behind a misleading `:hourglass: 你上一則訊息還在處理，請稍候` notice that implied queue semantics; and parallel @-mentions in the same channel raced on a shared `chat-session.json`, so the second writer's turn was overwritten on disk even when both Slack-side replies landed.

v0.13 closes both: a constructor-injected fake transport + 27-test integration harness lands first, then four tranches incrementally extract focused modules under that safety net, and the two multi-user bugs get fixed with semantics that match what the UX always implied.

### Added

- **`SlackGateway` integration harness** (PRs [#52](https://github.com/hanfour/pm-workspace-kit/pull/52)) — `packages/cli/test/harness/slack-fakes.ts` provides `FakeWebClient`, `FakeSocketModeClient`, `FakeLlmProvider`, `FakeMra`, and `buildHarness()`. `SlackAdapter` constructor now accepts optional `web` / `socket` / `llm` / `mraDoctor` / `runMraAsk` overrides (production path is byte-equivalent — defaults to real wiring when none supplied). 27 new integration tests cover DM happy-path, mra-ask escalate, channel @-mention free-chat, channel-with-active-case, `/pmk admin` slash command, reaction-based atom approval, presence broadcast / restart matrix, msg_too_long retry, and envelope dedup across all three event paths. The harness is the prerequisite that made tranches 1–3 below safe to land.
- **Multi-user channel concurrency** (PR [#53](https://github.com/hanfour/pm-workspace-kit/pull/53)) — the `inFlight` lock key changes from `channelId` to `${channelId}:${userId}`. Different users in the same channel can now ask the bot questions in parallel without waiting for each other's 60–90 s mra-ask round. A single user's rapid double-tap stays serialised (the original intent of the lock). Busy-notice text changes from `:hourglass: 已有訊息在處理中` → `:hourglass: 你上一則訊息還在處理，請稍候` to match the now per-user semantics.
- **Append-only channel message log** (PR [#53](https://github.com/hanfour/pm-workspace-kit/pull/53)) — `packages/cli/src/gateway/channel-log.ts` replaces the read-modify-write `chat-session.json` with per-channel JSONL: `~/.pmk/gateway/slack/channels/<channelId>/messages.jsonl` (and per-thread under `threads/<ts>/messages.jsonl`). `appendChannelTurns` uses a single `fs.appendFileSync` syscall → POSIX-atomic, so concurrent parallel writers from the new per-user-per-channel lock all land instead of last-write-wins dropping turns. `loadChannelTurns` streams + skips malformed lines + supports `limit` / `sinceMs` filters, and triggers a one-time migration from legacy `chat-session.json` on first read.
- **FIFO inflight queue** (PR [#55](https://github.com/hanfour/pm-workspace-kit/pull/55)) — `packages/cli/src/gateway/slack/inflight-queue.ts` replaces the pre-v0.13 "drop second message + misleading busy notice" model. Rapid follow-up messages behind an in-flight LLM round now actually queue FIFO (default depth 3) and drain in submission order. Key is the caller's: `userId` for DM, `${channelId}:${userId}` for channel @-mention. At-cap submissions get an explicit `:no_entry: 你已有多則訊息排隊中（上限 3 則），請等回覆後再發` rejection notice instead of silent drop. Queued submissions get `:hourglass: 你上一則還在處理，這則已排入隊伍（會依序處理）`. Slack envelope handlers now return fast (fire-and-forget) so the 3-second ack window stays comfortable.
- **Graceful shutdown drain** (PR [#55](https://github.com/hanfour/pm-workspace-kit/pull/55) review) — `SlackAdapter.stop({ drainTimeoutMs })` reordered to `socket.disconnect` → `queue.waitForAll` (bounded) → `presence.offline`. The SIGINT/SIGTERM handler passes `25_000` ms (K8s SIGKILL kicks in at 30 s); a stuck LLM round logs `drain timed out after 25000ms; abandoning remaining in-flight work` and continues so SIGKILL isn't what reaps the process. Without the drain, queued turns died with `process.exit(0)` — users who saw the "排入隊伍" notice never got a reply.

### Changed

- **`SlackAdapter` decomposed** (PRs [#52](https://github.com/hanfour/pm-workspace-kit/pull/52), [#54](https://github.com/hanfour/pm-workspace-kit/pull/54), [#55](https://github.com/hanfour/pm-workspace-kit/pull/55)) — three tranches under the new harness:
  - **Tranche 1** extracts `slack/presence.ts` (146 lines — broadcast fan-out + #44 suppress-on-fast-restart), `slack/envelope-dedup.ts` (45 lines — bounded-LRU dedup), `slack/concurrency.ts` (36 lines — `runWithConcurrency`). Adapter `1708 → 1597` (-111).
  - **Tranche 2** extracts `slack/escalation.ts` (308 lines — outbound `@-mention IT contacts` + inbound IT-reply absorb + asker-synthesis follow-up). Adapter `1640 → 1411` (-229).
  - **Tranche 3** extracts `slack/free-chat-turn.ts` (509 lines — full turn orchestration: seed + retrieval + prune + LLM + mra-ask + escalate + reply) and `slack/inflight-queue.ts` (141 lines — the new FIFO queue). Adapter `1411 → 1010` (-401).
  - **Net: -698 lines (-41%)** from the v0.12.0 baseline. Tranche 4 (dispatcher cleanup, target <800 lines) is deferred.
- Behaviour byte-equivalent across all three tranches; the harness's tests pass without modification at every step, which is exactly the safety net tranche 1 promised.

### Tests

`@pmk/cli` 312 → **362** (+50). Major additions:

- **Integration harness** (27 tests, Phase 1–3) — DM happy-path (3), mra-ask escalate round (3), channel @-mention free-chat + case path (2), `/pmk admin` slash (3), reaction-based atom approval (4), presence broadcast restart matrix (5), msg_too_long retry hardening (3), envelope dedup across DM / @-mention / slash (4).
- **Multi-user concurrency** (PR #53, 2 tests) — different users in same channel proceed in parallel; same user double-tap blocked with per-user notice.
- **Append-only channel log** (PR #53, 7 tests) — append-on-empty, FIFO ordering, malformed-line skip, `sinceMs` cutoff, legacy migration round-trip, `entriesToMessages` shape, multi-channel isolation.
- **FIFO inflight queue** (PR #55, 10 unit tests) — `enqueue` contract (`ran`/`queued`/`QueueFullError`), default `maxDepth=3`, FIFO order under release, key independence, error isolation (throwing work doesn't poison queue), `waitForAll` correctness, `onLog`-throwing-defence (broken logger can't lock a key out forever).
- **Inflight queue adapter integration** (PR #55, rewritten suite) — different users still parallel without queue notice, same-user double-tap queues with correct UX text, 4th submission rejected with cap notice.
- **Graceful shutdown drain** (PR #55 review, 2 tests) — `stop()` waits for in-flight work before broadcasting offline; `stop({ drainTimeoutMs })` honours timeout when work is genuinely stuck and logs the abandon.

Total across the workspace: 362 → **412** pass, 0 fail.

### Operator note

**User-visible Slack text changed.** Rapid follow-up DM/@-mentions now see one of three messages instead of the pre-v0.13 single dropped one:

- 1st follow-up while bot is replying: `:hourglass: 你上一則還在處理，這則已排入隊伍（會依序處理）` — and the message **will be processed**, not dropped.
- 4th submission while 3 are already queued: `:no_entry: 你已有多則訊息排隊中（上限 3 則），請等回覆後再發` — this one IS dropped, but explicitly.
- Channel @-mention from a different user while bot is busy with someone else: no notice at all, both run in parallel.

**Zero migration on disk.** The new `channels/<channelId>/messages.jsonl` layout migrates from legacy `chat-session.json` automatically on first read of an existing channel. Operators can `rm` legacy files manually after observing the migration in `events.log`, but the reader is idempotent — re-running upgrade is safe.

**Shutdown takes longer.** Pre-v0.13 graceful shutdown was sub-second; v0.13 now waits up to 25 s for queued / running LLM rounds to complete before exiting. The trade-off: users who saw the "排入隊伍" notice actually get their reply, instead of silent drop on `kill`. K8s `terminationGracePeriodSeconds` should be ≥30 (the default).

---

## [v0.12.1] — 2026-05-19 — README + CLI version catch-up

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.12.1)

### Why

Two non-feature drifts caught during a v0.12 review, neither blocking but both visible: the README `Latest release` section was stuck at v0.10.1 while the tag stream had marched to v0.12.0 (two minor versions of gateway hardening invisible to anyone reading the repo front page), and `pmk --version` had been reporting `0.7.0-dev` since v0.7.0 because Commander's `.version()` was a string literal that the v0.10.1 `bump-version.mjs` work never reached. Tying both off in one patch so the v0.12 series ends with the repo's outward-facing version surfaces in sync.

### Fixed

- **`pmk --version` no longer hardcoded.** `packages/cli/src/index.ts` now imports `version` from `../package.json` (via `resolveJsonModule`) and feeds it into Commander's `.version()`. The path resolves identically at compile time (`src/../package.json`) and at runtime from the built `dist/index.js` (`dist/../package.json`), both pointing at `packages/cli/package.json`, so `npm run version:bump` propagates to the CLI surface from this release forward with no additional wiring.

### Docs

- **README `Latest release` caught up v0.10.1 → v0.12.0.** Header date + version updated, narrative paragraph extended with the v0.10.1 → v0.12.1 chain (gateway presence + per-channel audience + monthly audit logs in v0.11.0, `msg_too_long` three-layer defense + `Context safety` audit section in v0.11.1, `anthropic-api` soft-flip + `token.usage` + `Token usage` audit section in v0.12.0, this README/CLI catch-up in v0.12.1), and four new rows in the release table.

### Tests

`@pmk/cli` 312 → **312** (unchanged): the version-source change is a 1-line wiring fix verified by a smoke test (`pmk --version` reports the bumped value, 0.12.0 before and 0.12.1 after `version:bump`). No new test was added because the fix relies on TypeScript's `resolveJsonModule` + Node's relative-`require` resolution, both of which are exercised by every release build; a dedicated unit test would test the runtime, not the change.

### Operator note

Zero migration. Existing `~/.pmk/` state and gateway config carry forward unchanged. Anyone scripting against `pmk --version` should be aware the reported value finally tracks the real release tag — if a script relied on the stale `0.7.0-dev` marker, update it.

---

## [v0.12.0] — 2026-05-08 — gateway: anthropic-api as default provider

### Why

v0.11.1 hardened the gateway against `msg_too_long` by lowering caps and adding an auto-retry path, but cause #2 from the 2026-05-07 incident — `claude-agent-sdk` spawning the local `claude` CLI and inheriting the host's `~/.claude/` config (skills/hooks/MCP descriptions) as un-budgeted system context — was absorbed by tighter caps, not eliminated. v0.12.0 flips the default to the direct Anthropic SDK so SDK overhead is no longer a budget unknown, and restores cap headroom.

Spec: [`apps/docs/docs/plans/2026-05-08-gateway-anthropic-api-default.md`](./plans/2026-05-08-gateway-anthropic-api-default.md). Migration: [v0.12 migration notes](./gateway/v0.12-migration.md).

### Changed

- **Default LLM provider auto-resolves to `anthropic-api` first** (was `claude-agent`). Soft flip — users with `ANTHROPIC_API_KEY` set auto-switch; users without it stay on `claude-agent` with no behavioural change. `PMK_PROVIDER=claude-agent` still pins the legacy path explicitly.
- **Cap defaults restored to operationally useful values** now that SDK overhead is gone on the default path:
  - `PMK_MAX_SESSION_TOKENS` 25_000 → 60_000
  - `PMK_SEED_CAP` 12_000 → 30_000
  - `PMK_MRA_RESULT_CAP` 16_000 → 40_000
- **`gateway init` prompts for `ANTHROPIC_API_KEY`** after Slack tokens; stored in `~/.pmk/gateway.json` `apiKey` field at mode 0600. Empty input keeps existing value or falls back to env var. The running gateway daemon needs a graceful restart to pick up a newly-set apiKey (matches the existing audience/escalation config-mutation pattern).

### Added

- **`token.usage` event** in `events-YYYY-MM.log` — emitted by `AnthropicApiKeyProvider.chat()` after each successful stream completion, when an `actor` is provided in `ChatOptions`. Fields: `actor`, `provider`, `model`, `inputTokens`, `outputTokens`, optional `cacheReadTokens` / `cacheCreationTokens`. Best-effort write — failures don't break the chat.
- **`Token usage` section** in `pmk gateway audit` rolls up the new events: total in/out, cache read (when non-zero), top-3 per-actor by input tokens, per-model breakdown.
- **`ChatOptions.actor`** optional field on the `LlmProvider.chat()` interface for usage attribution. Threaded through `chatWithContextRetry` automatically; CLI command-side wiring is future work.

### Tests

`@pmk/cli` 304 → **312** (+8): `resolver.ts` autoResolve order (apiKey-preferred + fail path), `AnthropicApiKeyProvider.chat()` token-usage emission with mocked stream + `finalMessage()`, no-emission when actor undefined, `events.ts` round-trip for `token.usage`, `audit.ts` aggregation, `audit-format.ts` `Token usage` rendering for non-zero + zero cases. Cap-default test assertions flipped from v0.11.1 values to v0.12.0 values.

### Forward-looking

`claude-agent` provider stays as a soft-flip fallback indefinitely. Re-evaluate deprecation in v0.13+ based on usage data from the new `Token usage` audit section. $-cost calculation is a v0.13+ candidate, gated on a stable price-table source. SlackGateway integration harness remains tracked as a v0.11.2 follow-up.

---

## [v0.11.1] — 2026-05-07 — gateway `msg_too_long` hardening

### Why

A live Slack thread on 2026-05-07 returned `pmk 內部錯誤：An API error occurred: msg_too_long` after several `mra-ask` rounds. Root-cause analysis surfaced four issues and v0.11.1 layers defenses against all of them so the failure mode does not reach production users again. See [`apps/docs/docs/plans/2026-05-07-gateway-msg-too-long-hardening.md`](./plans/2026-05-07-gateway-msg-too-long-hardening.md) for the full design spec, and `2026-05-07-gateway-msg-too-long-hardening-implementation.md` for the per-task TDD plan.

### Fixed

- **`msg_too_long` no longer reaches end users.** Three layered defenses:
  - (a) `pruneSessionIfNeeded` now runs **before** the LLM call (was after — closed a fail-loop introduced in v0.8.1 where a session over budget could never recover because prune only fired after a successful call).
  - (b) The PKB seed and `mra-ask` results are capped at write-time so a single bloated message cannot single-handedly exhaust the input window.
  - (c) Any residual `msg_too_long` triggers a typed `PmkContextTooLongError`, an automatic `forcePruneToMinimum`, and a retry. The reply is prefixed with `:scissors: 對話過長，已自動裁掉 N 輪舊訊息` so users know context was trimmed. Hard failure (both calls reject) shows `:x: 對話太長，請開新 thread 重新提問` instead of the raw API error.

### Changed

- `PMK_MAX_SESSION_TOKENS` default lowered 60_000 → 25_000 to leave headroom for system prompt, retrieval prefix, the SDK-inherited host context (`claude-agent-sdk` spawns the local `claude` CLI, which inherits `~/.claude/` skills/hooks/MCP descriptions), the new turn, and the model's reply.

### Added

- New env vars `PMK_SEED_CAP` (default 12_000 chars) and `PMK_MRA_RESULT_CAP` (default 16_000 chars) for per-host tuning. The previously-hardcoded 24_000-char `mra-ask` truncation in `buildMraSuccessMessage` is replaced by `PMK_MRA_RESULT_CAP`.
- New event types in `events-YYYY-MM.log`: `context.exceeded` (with `phase: "first-call" | "synthesise"`), `context.force-pruned`, `message.capped` (with `kind: "seed" | "mra-result"`).
- `pmk gateway audit` gains a `Context safety` section rolling up the new events. Tighten the `*_CAP` env vars if `context.exceeded` appears in your weekly audit.
- Helper `chatWithContextRetry` extracted to `packages/cli/src/gateway/slack/context-retry.ts` so the retry+force-prune+events pattern is unit-testable in isolation (no `SlackGateway` integration harness needed) and reused at both LLM call sites (`runFreeChatTurn` first-call, `synthesiseAfterMra` mra-ask round).

### Tests

`@pmk/cli` 274 → **304** (+30): unit coverage for `capMessageContent`, `forcePruneToMinimum`, `pruneSessionIfNeeded` extras-aware budgeting, `approxTokensFor` with `extra` param, `PmkContextTooLongError` detection, the six-discriminant `chatWithContextRetry` (happy / non-context error / context-then-success-with-scissors / context-then-fail / `dropped=0` degenerate / `phase=synthesise` audit), audit `contextSafety` rollup, formatter `Context safety` section non-zero + zero-count rendering, and the three new event-type round-trip in `gateway-events.test.ts`.

The seed-cap and mra-result-cap wiring sites in `slack/index.ts` and the `runFreeChatTurn` retry-prefix wiring rely on the constituent helpers' unit tests + manual verification (no `SlackGateway` integration harness in this release; tracked as a follow-up).

### Forward-looking

v0.12 is planned to switch the gateway provider from `claude-agent-sdk` to `anthropic-api`, removing the SDK-inherited host-context as a budget unknown. The cap mechanism from v0.11.1 stays; only the budgets relax toward the model's true context window. See the v0.12 stub at the end of the v0.11.1 design spec.

---

## [v0.11.0] — 2026-05-05 — gateway presence + per-channel audience + monthly audit logs

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.11.0) · closes [#23](https://github.com/hanfour/pm-workspace-kit/issues/23), [#44](https://github.com/hanfour/pm-workspace-kit/issues/44) · milestone [v0.11](https://github.com/hanfour/pm-workspace-kit/milestone/8)

### Why

Two issue-driven items plus one v0.10.x debt cleanup, sized to ship as one minor release:
- **#44** — kill→restart cycles broadcast spurious "重新上線" (live-observed during v0.10.0 verification).
- **#23** — `pickAudience` had no channel tier, forcing per-user overrides for "this channel defaults to exec" cases.
- **events.log unbounded growth TODO** from v0.10 — bumped in priority because #44 adds presence events on every start/stop.

See the [v0.11 migration notes](./gateway/v0.11-migration.md) for a focused operator-facing summary of the layout + behaviour changes.

### Added

- **Per-channel audience override** ([#23](https://github.com/hanfour/pm-workspace-kit/issues/23)) — new `cfg.audience.channels: Record<channelId, AudienceKey>` tier between per-user and workspace default. CLI: `pmk gateway audience set-channel <channelId> <key>` / `unset-channel`. Slack admin: `/pmk admin audience set-channel #channel <key>` / `unset-channel`. `extractChannelId` helper handles `<#C0X|name>` mention, `<#C0X>` bare mention, and raw `C0X` / `G0X` / `D0X` IDs. Resolution order at turn time: per-user → per-channel → workspace default.
- **Graceful-shutdown marker** ([#44](https://github.com/hanfour/pm-workspace-kit/issues/44)) — single-use file at `~/.pmk/gateway/shutdown-marker` written on `SIGTERM`/`SIGINT`. The next `startHeartbeat()` reads + consumes it to distinguish "kill -> restart" from a real crash; `wasOffline=false` and the back-online broadcast is suppressed when the offline gap is under 5 minutes.
- **Presence event types in `events.log`** ([#44](https://github.com/hanfour/pm-workspace-kit/issues/44)) — `gateway.online` and `gateway.offline` join the JSONL stream with monotonic per-process `seq`, human-readable `reason` (`crash-recovery` / `graceful-fast-restart` / `graceful-long-downtime` / `shutdown`), `broadcast` bool, and `offlineDurationMs`. Lets the audit detect rapid restart cycles and the graceful-vs-crash split.
- **Monthly-partitioned JSONL ledger** (PR #47) — new `packages/cli/src/gateway/monthly-jsonl.ts` shared util powers both `events.log` and `admin.log`. Files are now `~/.pmk/gateway/events-YYYY-MM.log` / `admin-YYYY-MM.log` (UTC month). Legacy single-file ledgers from v0.10 are still read-only-merged so upgrades don't lose history. No eviction — operators can `rm` ancient partitions manually; the reader silently skips missing months.

### Fixed

- **Restart-cycle broadcast spam** ([#44](https://github.com/hanfour/pm-workspace-kit/issues/44)) — heartbeat is no longer deleted on graceful shutdown (it stays for `offlineDurationMs` accounting), and `broadcastBackOnline()` checks the gap before posting. The same change exposes the issue's secondary symptom: `broadcast()`'s O(N) serial fan-out is now `runWithConcurrency(limit=3)`, finishing in seconds instead of 20+ s and isolating per-recipient errors. Live-Slack verified: a 1.3-second graceful restart records `gateway.online ... broadcast:false offlineDurationMs:1332` and the channel sees no spurious "重新上線" message.
- **`events.log` unbounded growth** (v0.10.x debt) — closed by the monthly partitioning above.

### Tests

248 → **274** (+26 across `@pmk/cli`). Major additions:
- Heartbeat marker decision matrix (5 branches: first boot, marker fresh, marker stale, no-marker fresh heartbeat, no-marker stale heartbeat) + corrupt-marker safety + upgrade-migration story
- `runWithConcurrency` (4 cases: empty list, peak in-flight respected, single-task rejection isolated, limit > task count)
- `pickAudience` channel tier (5 cases: channel applies absent user, per-user beats channel, fall-through, undefined channelId, back-fill on old config) + empty-string channelId guard
- `/pmk admin audience set-channel` / `unset-channel` end-to-end (mention wrapping, raw ID, garbage rejection, round-trip)
- Monthly partitioning (current-month write + legacy NOT written, legacy + partition merge order, multi-month aggregation with `sinceMs` cutoff, default 12-month window, legacy mixed-content malformed-line skip, admin-log mirror)

Plus a new **`@pmk/shared`** test surface (was 0 → **24**): shape-based snapshot tests covering `BASE_RULES`, all four audience prompts, `pickGatewayPrompt` round-trip, `AUDIENCE_KEYS`, `PROMPTS` map coverage, and `DEFAULT_CONFIG` shape.

Total across the workspace: 274 → **324** pass, 0 fail.

### Operator note

Zero migration. All schema changes are additive and back-fill-compatible. **First kill→restart after upgrade still broadcasts "重新上線" once** — the v0.10 gateway shut down without writing a marker, so the v0.11 build correctly treats it as a fresh boot. From the second graceful restart onward, suppression works.

For tail-style debugging, switch from `tail -f ~/.pmk/gateway/events.log` to `tail -f ~/.pmk/gateway/events-$(date -u +%Y-%m).log` (note the `-u` for UTC, since partitions roll on UTC month boundaries).

## [v0.10.1] — 2026-05-05 — workspace version sync + mra stdout cap

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.10.1)

### Why

Two trailing items from the v0.10 milestone close, neither feature-shaped: workspace `package.json` files had drifted to `0.3.0` while git tags marched to `v0.10.0`, and `runMraAsk` accumulated stdout via `+=` with no upper bound — both observational risk on v0.10.0 day, but worth tying off before the v0.11 milestone opens its own surface.

### Added

- **`scripts/bump-version.mjs`** + root npm script `version:bump` — bumps root + every `apps/*` and `packages/*` `package.json` to a given semver in one pass. Used to bring all 7 manifests in sync to `0.10.1`. Lands the tag-vs-manifest sync into the release flow so the next minor close cannot drift again.
- **Exported `MAX_MRA_STDOUT_BYTES` (10 MiB)** from `packages/cli/src/adapters/mra.ts` — soft cap on captured `mra ask` stdout, matching the old `execFile` `maxBuffer` default.

### Fixed

- **`runMraAsk` stdout accumulator** — switched from `string +=` to `chunks.push() + join` to remove the latent O(n²) string-concat cost on large outputs, and added a soft 10 MiB cap that SIGTERMs the child if exceeded. Defence in depth: live `mra ask` rounds are KB-scale, but a wedged subprocess streaming unbounded output would have pressured host memory in the prior implementation. The overflow reason is also classified as **non-transient**, so the v0.7.3 retry-once policy doesn't burn a second round on a path that just reproduces the same overflow.
- **`package.json#version` workspace drift** — root and 6 sub-packages now report `0.10.1` instead of the stale `0.3.0` they had carried since v0.4.

### Tests

247 → **248** (+1): `runMraAskWithBinary` overflow case — fake mra writes past the cap, asserts `ok=false`, reason mentions both `stdout exceeded` and the exact `MAX_MRA_STDOUT_BYTES` byte count, and `attempts === 1` (proves overflow is treated as non-transient).

Total across the workspace: 273 → **274** pass, 0 fail.

### Operator note

Zero migration. The cap is generous (10 MiB) and the overflow reason surfaces clearly in `events.log` (`mra-ask.end ok=false`) plus the user-facing failure message. Hosts that previously relied on capturing >10 MiB of `mra ask` stdout (none observed in dogfood) would now see a non-ok result with the explicit cap — but at that scale the prior code path was already O(n²) and would have stalled the gateway.

For the next release, run `npm run version:bump <semver>` before tagging — the bump should be its own commit so the tag points at a tree where every manifest already reads the new version.

## [v0.10.0] — 2026-05-04 — gateway observability + Slack UX

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.10.0) · closes [#22](https://github.com/hanfour/pm-workspace-kit/issues/22), [#24](https://github.com/hanfour/pm-workspace-kit/issues/24) · milestone [v0.10](https://github.com/hanfour/pm-workspace-kit/milestone/7)

### Added

- **`pmk gateway audit [--days N]`** ([#24](https://github.com/hanfour/pm-workspace-kit/issues/24)) — operator-facing rollup of recent knowledge-loop activity: per-user / per-audience turn breakdown, mra-ask success/retry/fail split with median duration, escalate triggered / absorbed / pending counts and median time-to-IT-reply, atom corpus stats with top contributors, plus flags for stuck pending atoms (> 24h) and stale escalations (> 48h). Window defaults to 7 days; `--days` accepts 1–365.
- **`~/.pmk/gateway/events.log`** — append-only JSONL ledger for the four event types the audit consumes (`turn.processed`, `mra-ask.end`, `escalate.triggered`, `escalate.absorbed`). Mirrors `admin.log` in shape and contracts; tolerant reader skips malformed lines.
- **Live mra-ask progress in Slack** ([#22](https://github.com/hanfour/pm-workspace-kit/issues/22)) — `runMraAsk` now uses `spawn` instead of `execFile` so each stdout line streams into the placeholder message via a 3-second last-line-wins throttle. The 30–90s mra round shows `[ask] PKB loaded`, `[ask] querying...` etc. tick by instead of a static spinner. `web.chat.update` rate well under Slack Tier 3; trailing fire cancelled on completion so a late progress line can't briefly overwrite the synthesised reply.

### Fixed

- **ANSI escape codes in progress placeholder** — live-Slack verification on 2026-05-04 caught a defect: `mra` colorizes its `[ask]` / `[pkb]` tags with ANSI SGR sequences (`\x1b[1;37m[ask]\x1b[0m querying: erp`), and the original sanitizer in #43 only stripped Slack mrkdwn meta. Slack rendered the residual `[1;37m` / `[0m` as literal text, making the streaming UX worse than the static spinner v0.10 was meant to replace. Sanitizer now strips ANSI SGR before mrkdwn meta. Extracted as `sanitizeProgressLine` in `src/gateway/slack/progress.ts` for direct unit testing.
- **`mraDoctor` stale-workspace fall-back** — long-standing comment-vs-code mismatch in `src/adapters/mra.ts`. Comment promised "stale `cfg.mraWorkspace` falls back to cwd walk so a host with a valid workspace ancestor isn't silently broken"; code returned `ok:false` instead. Code now matches the spec, with the error reason mentioning both the stale config and the failed walk so operators see the full picture.

### Notes

- Audience binding is captured at turn time, so changing `audience default` after the fact does not rewrite the audit's history.
- Atom corpus stats (`total`, `approved`, `pending`, `topContributors`) are intentionally lifetime, not window-scoped — atoms persist in `~/.pmk/knowledge/` across windows.

### Tests

193 → **247** (+54 across the milestone): `pmk gateway audit` formatter + integration cases (#24), throttle leading/trailing/cancel behaviour (#22), spawn-based `runMraAsk` retry / SIGTERM / progress / partial-line handling (#22), `sanitizeProgressLine` ANSI + mrkdwn + length-cap, `mraDoctor` fall-back semantics.

### Operator note

Zero migration. `events.log` auto-creates on first write; progress streaming activates automatically when an mra-ask round runs. If `cfg.mraWorkspace` was previously set to a now-deleted path, the runtime now silently falls back to a cwd-walk (the gateway startup pre-flight still warns at boot, so misconfiguration isn't hidden — just no longer fatal at request time).

## [v0.9.1] — 2026-04-28 — `/pmk` real Slack slash-command (no leading-space workaround)

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.9.1) · closes [#39](https://github.com/hanfour/pm-workspace-kit/issues/39)

### Why

Real-Slack verification of v0.9.0 found that typing `/pmk admin help` in Slack triggered Slackbot's "/pmk 是無效指令" intercept and never reached the bot. Slack's client blocks `/`-prefixed messages whose slash-command isn't registered on the app side. The only way to actually deliver the message was to type a leading space (` /pmk admin help`) so the gateway's existing `message`-event path could pick it up after `text.trim()`. Same gap had existed for every `/pmk` command since v0.7.0 (`help`, `open`, `show`, `close`, `cases`).

### Fixed

- **Real Slack slash-command** — `/pmk` is now registered as a Slack slash-command on the app side; SlackAdapter subscribes to the Socket Mode `slash_commands` envelope (`packages/cli/src/gateway/slack/index.ts`). No more leading-space workaround. Slack autocompletes `/pmk` and the bot replies as a top-level message (slash commands have no anchoring message, so no thread).
- The legacy ` /pmk ...` text-message path stays in place as a fallback for users who learned the workaround and for deployments where the slash-command isn't registered.
- Empty body (`/pmk` alone) routes to `help` so first-time users discover the surface.

### Added

- `slashCommandArgsFromBody(body)` — exported pure helper that translates a Slack `slash_commands` envelope body into `handleSlashCommand` args. Lets us unit-test the rest/scope decision without instantiating `SlackAdapter`.

### Changed

- `handleSlashCommand`'s `threadTs` is now optional. Slash-command envelopes have no anchor message, so omitting it is correct; the legacy text-message path still passes a thread_ts.
- `chat.postMessage` only includes `thread_ts` when defined (was always passing it before, even when undefined).

### Tests

185 → 193 (+8): `slashCommandArgsFromBody` for DM/channel scope split, empty-text fallback to `help`, missing user_id/channel_id returns null, undefined body returns null, DM-only check stays downstream.

### Operator note

Existing v0.9.0 deployments need to (one-time):

1. Register `/pmk` as a Slash Command at `https://api.slack.com/apps/<APP_ID>/slash-commands` (Socket Mode is on, no Request URL needed)
2. Reinstall the app to add the `commands` scope
3. Restart `pmk gateway start` with the v0.9.1 binary

Until step 3 is done, the leading-space path is the only one that works. After step 3, both paths work in parallel.

## [v0.9.0] — 2026-04-28 — Slack admin commands + audit log

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.9.0) · closes [#31](https://github.com/hanfour/pm-workspace-kit/issues/31)

### Added

- **`/pmk admin <subcommand>`** runs gateway-config mutations from inside Slack — no host terminal needed for day-to-day ops. Subcommands cover `status`, `audience`, `escalation`, `atoms` (list/show/approve/reject), `admins`, and `audit`. See the [Admin commands section](./gateway/lifecycle.md#11-admin-commands-v090) of the lifecycle doc.
- **`pmk gateway admin <add|remove|list|audit>`** — host CLI counterpart for bootstrapping the very first admin and rotating the set. Bootstrap is intentionally terminal-only — there is no Slack path to grant yourself admin.
- **Append-only audit log** at `~/.pmk/gateway/admin.log`. Every admin mutation, whether from Slack or CLI, writes one JSONL line capturing `actor`, `origin`, `action`, `args`, `ok`, and (on failure) a `reason`. Surfaced via `/pmk admin audit [N]` and `pmk gateway admin audit [N]`.
- **`cfg.admins: string[]`** in `~/.pmk/gateway.json`. Back-fills to `[]` for legacy configs so existing deployments keep working with no migration step.
- **`isAdmin(cfg, userId)`** helper used by the Slack adapter's `/pmk admin` route gate.

### Trust model

- **Bootstrap requires terminal access.** The first admin must come from the host CLI; you cannot grant yourself admin from Slack.
- **DM-only.** `/pmk admin` in a channel returns `:no_entry_sign:` and does nothing. Keeps audit-relevant mutations out of channel scrollback.
- **Last-admin protection.** Removing the only admin is refused — even self-removal — to prevent locking the workspace out of the Slack admin path entirely. Add a replacement first.
- **Slash-command surface is a deliberate subset.** `init`, token rotation, `atoms edit`, process stop/restart, and blocklist mutation are all CLI-only. `atoms edit` in particular: pasted Slack content would land verbatim in retrieval, and the CLI's `$EDITOR`-with-validation path is safer.

### Tests

166 → 185 (+19): `isAdmin` true/false + legacy back-fill, audit-log round-trip + tail-limit + malformed-line skip + non-fatal write failure, Slack handler help / unknown subcommand / audience set + invalid tier / admins add+remove + last-admin protection + invalid Slack-id rejection / audit subcommand surfaces entries / escalation default vs repo pool isolation, plus mention parsing (`<@U0X>`, `<@U0X|name>`, bare `U0X`, garbage).

## [v0.8.5] — 2026-04-28 — Slack reaction-based atom approval

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.8.5) · closes [#21](https://github.com/hanfour/pm-workspace-kit/issues/21)

### Added

- **✅ / ❌ reactions on the bot's pending-notice** now approve / reject the atom in-flow:
  - ✅ (`white_check_mark`, `heavy_check_mark`, `+1`) → `approveAtom`, posts ":books: 已生效..." reply
  - ❌ (`x`, `-1`) → `rejectAtom` (deletes the file), posts ":wastebasket: 已捨棄..." reply
- Trust model: only the original IT contributor (`atom.source.contributorUserId`) can react. Other reactors are silently ignored. Random thread participants can't approve atoms.
- `KnowledgeAtom.approval?: { channelId, messageTs }` captures the bot's confirmation post `ts` so reactions can be mapped back to the originating atom. Atoms saved before v0.8.5 don't have this anchor and can't be reaction-approved (CLI fallback still works).
- `findAtomByApprovalMessage(channelId, messageTs)` helper for the Slack handler.

### Changed

- `gateway init` walkthrough now lists `reactions:read` scope and `reaction_added` event subscription as v0.8.5+ requirements. Existing v0.7.x apps without these scopes keep working — no events fire, TTL auto-promote remains the safety net.
- The pending-notice text now invites reaction directly: "直接 ✅ 或 ❌ react 這條訊息可立即 approve / reject".

### Tests

162 → 166 (+4: anchor lookup matches; mismatched channel/ts returns undefined; legacy atoms without anchor return undefined; approval round-trips through save/load).

## [v0.8.4] — 2026-04-28 — BM25 / TF-IDF retrieval for knowledge atoms

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.8.4) · closes [#19](https://github.com/hanfour/pm-workspace-kit/issues/19)

### Added

- New `packages/cli/src/gateway/atom-index.ts` — BM25-scored TF-IDF index over approved atoms via `@pmk/rag`. Pending atoms are excluded at index-build time (the v0.7.4 TTL gate is preserved). Index file persisted at `~/.pmk/knowledge/.index/<scope>.json`; auto-rebuilds when any atom file's mtime is newer than the index's `builtAt`.
- `pmk gateway atoms reindex [--scope <name>]` — force-rebuild the index. Useful after tweaking thresholds or to confirm the index is current.
- `PMK_ATOM_VECTOR_THRESHOLD` env var — corpus-size threshold above which `searchAtoms` switches from keyword overlap to BM25. Default `50`.

### Changed

- `searchAtoms` now picks its scoring path at runtime by corpus size:
  - `< threshold` (small corpus): keyword + tag overlap (the v0.7.0 path; cheap, predictable)
  - `>= threshold` (large corpus): BM25 via the new index
- BM25 falls back to keyword on empty results, so single-token CJK queries that the tokenizer can't handle still work.

### Why

The keyword + tag scoring drifts as the corpus grows past a few dozen atoms — partial token matches and CJK bigram noise surface irrelevant atoms above relevant ones. Atom retrieval that's *worse* than no retrieval is dangerous because the model treats them as ground truth. BM25 fixes the ranking quality without requiring an external embedding API.

(Issue title was "vector retrieval" but `@pmk/rag` is BM25 / TF-IDF, which is the practically-useful upgrade. Pure JS, no embedding cost, no network dependency.)

### Tests

158 → 162 (+4: index excludes pending, BM25 returns approved-ordered, approvedAtomCount filter, mtime invalidation triggers rebuild).

## [v0.8.3] — 2026-04-28 — atoms search + edit CLI + commander option pass-through

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.8.3) · closes [#20](https://github.com/hanfour/pm-workspace-kit/issues/20)

### Added

- **`pmk gateway atoms search <query> [--scope <name>] [--limit N]`** — wraps `searchAtoms()` for dry-run retrieval ranking. Useful for sanity-checking after a new atom lands ("would this be retrieved when someone asks X?") without DM-ing the bot. Output: rank | id-prefix | scope | tags | question table.
- **`pmk gateway atoms edit <id-or-prefix>`** — opens the atom's `.md` in `$EDITOR` (fallback `vi`). Post-save validation: re-parses via `gray-matter`, ensures `id` and `createdAt` are unchanged, restores the pre-edit version on parse failure. Tag/summary/answer changes are unrestricted.

### Fixed

- **Commander option pass-through.** Previously `pmk gateway atoms list --pending`, `--scope`, `--limit` etc. were eaten by Commander as unknown root options before reaching the gateway handler. Workaround was `pmk gateway atoms list -- --pending`. Now `--xxx` flags pass through cleanly via `enablePositionalOptions()` + `passThroughOptions()`.
  - The deprecated `pmk gateway escalation add --default <userId>` form still works (still emits a deprecation warning).

### Tests

158/158 pass (no new — the underlying `searchAtoms` and `findAtomByPrefix` are tested; CLI integration verified via manual smoke).

## [v0.8.2] — 2026-04-28 — escalate self-tag detection

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.8.2) · closes [#30](https://github.com/hanfour/pm-workspace-kit/issues/30)

### Fixed

- When a model emits `escalate` but the resolved escalation pool is empty (or contains only the asker themselves), the gateway no longer silently logs and drops the mention. It now posts a visible `:warning:` message in the Slack thread naming the config gap and the exact `pmk gateway escalation add ...` commands to fix it. The pending-escalation marker is also skipped (no point waiting for an absorb that can't happen).
- The asker is filtered out of the resolved pool before any `@`-mention. Previously, if the only configured contact happened to be the same person who asked the question, the bot would `@`-mention them at themselves.

### Added

- `pickEffectiveEscalationPool(cfg, repo, askerUserId)` helper in `gateway/config.ts` — single-source-of-truth for "which contacts should we @-mention given this asker?". Used by `handleEscalation` and unit-tested in isolation.

### Caught by

2026-04-28 dogfood: real escalate flow on a PM scoping question logged `escalate requested but no contacts configured; skipping mention` while the bot's Slack reply degraded to prose ("建議兩個行動: SQL 查 / 找 AOE/PM 同仁"). The host had no way to tell from Slack that the v0.7 escalate flow was suppressed for a config reason.

### Tests

156 → 158 (+2: pool-with-asker filters self; both-pools-empty stays empty).

## [v0.8.1] — 2026-04-28 — session context-window auto-pruning

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.8.1) · closes [#18](https://github.com/hanfour/pm-workspace-kit/issues/18)

### Added

- `pruneSessionIfNeeded(session)` in `gateway/messaging.ts` — when a session crosses `MAX_SESSION_TOKENS` (default `60_000`, override via `PMK_MAX_SESSION_TOKENS` env), drops the oldest non-seed turns. Always preserves the PKB seed pair plus the most recent `KEEP_RECENT_TURNS` (default 10) user/assistant pairs; inserts a synthetic `(此處省略 N 輪較舊的對話以節省 context)` marker so the model knows there was earlier history.
- Idempotent — re-running on an already-pruned session is a no-op until enough new turns push back over cap.
- Host log line `pruned session: dropped N turn-pair(s); now <tokens> approx tokens` confirms when it fires.

### Why

Until v0.8.1, `UserSession.messages` accumulated forever. Each gateway-DM turn pushes 2 messages (user + assistant), the mra-ask round adds 2 more, the PKB seed adds 2 on first turn. After ~50 turns in a single thread the session approaches the model's context window — slow LLM round-trips, eventual `context_length_exceeded`, linear token-cost growth. v0.8.1 caps that.

### Tests

151 → 156 (+5: under-cap no-op, over-cap pruning preserves seed + tail, idempotent on already-pruned, no-seed branch, single-huge-message edge case).

## [v0.8.0] — 2026-04-28 — `pm` audience tier

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.8.0) · closes [#27](https://github.com/hanfour/pm-workspace-kit/issues/27)

### Added

- New audience tier `pm` between `tech` and `biz`. Keeps full structural depth (file paths, model names, real findings) for *what exists*, but translates *questions back to the user* into PM vocabulary — no formulas, no SQL, no bare schema column names. Includes a translation cheat-sheet in the prompt so the model has explicit examples ("vCPM = cv / impression × 1000 × price?" → "vCPM 在你們有兩種意思：對廣告主報的成本 vs 對媒體分潤的單價。要看哪一種？").
- `pmk gateway audience set <userId> pm` and `pmk gateway audience default pm` now valid.
- `AUDIENCE_KEYS` exported from `@pmk/shared` updated to `["tech", "pm", "biz", "exec"]`.

### Caught by

Live dogfood 2026-04-28: a real PM project-scoping question got an excellent tech-tier reply (BigQuery vs API Gateway structural finding was perfect) but alignment questions phrased in formula-grade vocabulary that no PM could answer without first re-asking engineering — defeating the point. The PM tier closes that gap.

### Tests

148 → 151 (+3: prompt body assertions, AUDIENCE_KEYS shape, per-user pm setting).

## [v0.7.5] — 2026-04-28 — mra timeout-kill mis-classification

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.7.5) · PR [#25](https://github.com/hanfour/pm-workspace-kit/pull/25)

### Fixed

- **Critical**: Node's `execFile` timeout-kill produces `err.killed=true` / `err.signal="SIGTERM"` (with `err.code=null`), but the v0.7.0 detection checked `err.code === "ETIMEDOUT"` — so timeouts had **never** been correctly identified. Every timeout was labeled `Command failed: <argv>`, mis-leading operators and the LLM, and tripping the v0.7.3 retry-once on questions that always needed more time than the cap.
- Detect signaled-kill via `err.killed` / `err.signal === "SIGTERM"` in addition to the original `ETIMEDOUT` code path.

### Changed

- Default mra-ask timeout 120s → **300s**. Live dogfood (2026-04-28) showed a complex 4-clause CJK question legitimately needs 160s of mra-internal LLM time; the v0.7.0 cap was killing healthy queries.
- Slack placeholder copy `(最多 2 分鐘)` → `(最多 5 分鐘)` to match.

### Caught by

A real escalate-flow turn with a multi-clause CJK whitelist question. Symptoms looked like "mra returned no results" but were actually pmk's premature `SIGTERM`. Manual reproduction of the same query: exit 0, 160s, perfect 3 KB answer.

## [v0.7.4] — 2026-04-28 — atom approval (TTL hybrid)

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.7.4) · PR [#15](https://github.com/hanfour/pm-workspace-kit/pull/15) · closes [#14](https://github.com/hanfour/pm-workspace-kit/issues/14)

### Added

- `KnowledgeAtom` gains `status: "pending" | "approved"` and `expiresAt?: number`. Fresh atoms enter `pending` with a 24h TTL.
- `pmk gateway atoms` CLI: `list [--all|--pending|--approved] [--scope <name>]`, `show <id-or-prefix>`, `approve <id-or-prefix>`, `reject <id-or-prefix>`. ID prefix matching: any unique prefix resolves.
- `loadAtoms()` auto-promotes pending atoms whose `expiresAt` has passed (idempotent on subsequent loads).

### Changed

- `searchAtoms()` now filters out `status: "pending"` atoms — pending content is invisible to retrieval until promoted.
- Slack absorb confirmation message changed from ":books: 已吸收..." to ":hourglass_flowing_sand: 暫存為 pending, 24h 後自動生效..." with id prefix + approve/reject CLI hints.

### Compatibility

Atoms written by v0.7.0–v0.7.3 have no `status` field on disk; the parser treats missing as `approved` so the existing corpus keeps working without rewrites.

### Tests

141 → 148 (+7 covering pending exclusion, auto-promotion, approve/reject, prefix collision).

## [v0.7.3] — 2026-04-28 — gateway dogfood follow-ups (round 2)

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.7.3) · PR [#13](https://github.com/hanfour/pm-workspace-kit/pull/13)

### Added

- Startup-time `mraWorkspace` validation: `runGateway()` logs the workspace state at boot — `mra workspace: <path>`, a stale-warn, or `not configured … falling back to launch-cwd walk`. Stale paths surface at startup instead of at first DM.
- `MraAskResult.attempts` field; `runMraAsk` retries once on transient failures (no stderr, not timeout, not binary-missing). Matches the 2026-04-28 dogfood signature where a manual retry succeeded.
- New `packages/cli/src/gateway/messaging.ts` — `buildIngestSeed`, `buildMraFailureMessage`, `buildMraSuccessMessage`, `truncate` extracted from `slack/index.ts` for testability.

### Tests

132 → 141 (+9 covering helper formatting, retry attempts, startup hooks).

## [v0.7.2] — 2026-04-28 — gateway dogfood follow-ups (round 1)

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.7.2) · PRs [#11](https://github.com/hanfour/pm-workspace-kit/pull/11), [#12](https://github.com/hanfour/pm-workspace-kit/pull/12) · closes [#8](https://github.com/hanfour/pm-workspace-kit/issues/8), [#9](https://github.com/hanfour/pm-workspace-kit/issues/9), [#10](https://github.com/hanfour/pm-workspace-kit/issues/10)

### Added

- `GatewayConfig.mraWorkspace?: string` — explicit absolute path to the workspace dir holding `.collab/repos.json`. Lets `pmk gateway start` run from any cwd. `PMK_MRA_WORKSPACE` env override available for CI/containers.
- `mraDoctor({workspace?})` — explicit workspace wins when set AND valid; stale config returns a clear hint instead of silently falling through to cwd walk.
- `pmk gateway init` prompts for the path (auto-suggests detected workspace from cwd).
- `pmk gateway status` shows configured path with `(ok)` / `(no .collab/repos.json)` marker.

### Changed

- Failed `mra ask` now surfaces stderr / partial stdout in both the gateway host log AND the LLM's apology context (via `mra-stderr` / `mra-partial-stdout` fenced blocks). The model is instructed to cite the specific cause instead of a generic "unknown".
- `pmk gateway escalation add/remove` accepts the canonical positional `default` (no dashes); legacy `--default` form still works but emits a deprecation warning.
- Slack userId validation in CLI (`^[UW][A-Z0-9]{2,}$`) rejects typos like `@hanfour` early.

### Tests

119 → 132 (+13 covering config back-fill, env override, mraDoctor branches, escalate parsing, audience picker, runMraAsk hard-failure).

## [v0.7.1] — 2026-04-27 — gateway prompt override

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.7.1) · PR [#7](https://github.com/hanfour/pm-workspace-kit/pull/7)

### Fixed

- **Critical**: live dogfood revealed the v0.7 directive layer (`mra-ask`, `escalate`) was effectively dead. `BASE_RULES` (inherited by all gateway-DM prompts) opens with "you have NO tools, NO skills…" which contradicts the `GATEWAY_TOOLBOX` rules. Models defaulted to the safer no-tools rule and refused to emit directives.
- Fix: prepend an explicit override at the top of `GATEWAY_TOOLBOX` re-permitting the directive blocks for gateway-DM context.

Without this fix all the v0.7 plumbing worked in unit tests but the LLM never started the chain — the bot would say "I don't have access to the code" exactly when it should have asked pmk to run mra-ask.

## [v0.7.0] — 2026-04-27 — pmk gateway (Slack bridge, Socket Mode)

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.7.0) · PR [#6](https://github.com/hanfour/pm-workspace-kit/pull/6) · ADR-0006, PRD-2026-0005

### Added

- **`pmk gateway`** CLI verb with `init / start / status / stats` plus the audience and escalation pool subcommands. Host runs the bridge in the foreground; users DM or `@`-mention `@pmk` from their existing Slack workspace.
- **Slack Socket Mode adapter** (`@slack/socket-mode` v2). No public URL, no tunnel, no SaaS. Heartbeat-driven offline UX with `:zzz:` / `:wave:` broadcasts.
- **DM personal sessions + channel-shared cases** persisted under `~/.pmk/gateway/slack/`.
- **Per-thread session isolation** — top-level DMs share a "main" session, each Slack thread gets its own.
- **Channel free-chat fallback** when no active case (with PKB grounding instead of refusing).
- **Audience-aware prompts** (`tech` / `biz` / `exec`) — same answers, different tone. Per-user override.
- **Auto-mra-ask round** — model emits a fenced `mra-ask` block, pmk runs `mra ask <repo>`, synthesises with the result.
- **Escalate → absorb → retrieval** — model emits `escalate`, pmk `@`-mentions an IT contact, absorbs their reply as a `KnowledgeAtom` (`~/.pmk/knowledge/<scope>/<slug>.md`), retrieves it for future similar questions.
- **Slash commands** inside Slack: `/pmk open|show|close|cases|help`.
- **Honest offline UX** — heartbeat file ticked every 30s; on stale (> 60s) or graceful shutdown, broadcasts presence change to recent conversations.

### Security / hardening

- **Path traversal sandbox** for atom storage — `safeScope()` strips everything outside `[a-zA-Z0-9_-]` at every entry point. Prompt-injected `repo: ../../tmp/foo` lands as `tmp-foo`, never escapes `~/.pmk/knowledge/`.
- **Bounded envelope LRU** (2 000 entries) prevents memory growth on long-running hosts.
- **gray-matter** for atom front-matter — newlines / quotes / backslashes don't corrupt files.
- **Race fix**: pending-escalation marker claimed before LLM extraction (no duplicate atoms on fast IT replies).
- **Timeouts** — extractor + mra-ask both capped at 120s.

### Tests

75 → 119 (+44 covering thread isolation, audience picker, escalate parser, atom round-trip, ranked search).

## [v0.6] — 2026-04 — pmk case (long-lived bug investigation files)

PR [#5](https://github.com/hanfour/pm-workspace-kit/pull/5)

`pmk case` verb — symptom / hypotheses / evidence / next-questions persisted across sessions. The `case-update` fenced-block protocol becomes the foundation reused by v0.7's gateway flow.

## [v0.5] — 2026-04 — pmk × mra bridge

PRs [#2](https://github.com/hanfour/pm-workspace-kit/pull/2), [#3](https://github.com/hanfour/pm-workspace-kit/pull/3), [#4](https://github.com/hanfour/pm-workspace-kit/pull/4) · ADR-0005, PRD-2026-0004

`pmk ingest mra:--all` and `pmk explore <repo>` — code-intelligence work delegated to [multi-repo-agent](https://github.com/hanfour/multi-repo-agent) instead of growing pmk's own grep.

## [v0.4] — 2026-04 — desktop app + full CLI

PR [#1](https://github.com/hanfour/pm-workspace-kit/pull/1)

Electron desktop app (chat panel + worktree manager). CLI verbs M0-M7: `propose / draft / discuss / ask / debug / index / resume / worktree / tdd`.

## [v0.1–v0.3] — 2026-03 to 2026-04 — initial templates + traceability

Front-matter validation, Mermaid dependency graph, ADR / handoff / north-star templates, Confluence sync, Docusaurus docs site (EN + zh-TW). See [git log](https://github.com/hanfour/pm-workspace-kit/commits/main) for the early PRs.
