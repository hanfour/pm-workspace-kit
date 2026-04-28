---
sidebar_position: 99
---

# Changelog

All notable changes to **pm-workspace-kit** are documented here.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each release also has a longer narrative on [GitHub Releases](https://github.com/hanfour/pm-workspace-kit/releases) with rationale, dogfood notes, and test plans.

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
