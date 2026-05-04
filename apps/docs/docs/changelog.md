---
sidebar_position: 99
---

# Changelog

All notable changes to **pm-workspace-kit** are documented here.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each release also has a longer narrative on [GitHub Releases](https://github.com/hanfour/pm-workspace-kit/releases) with rationale, dogfood notes, and test plans.

## [Unreleased] — v0.10 (gateway observability + Slack UX)

Working milestone: [v0.10](https://github.com/hanfour/pm-workspace-kit/milestone/7). Items below land on `feat/v0.10-*` branches and roll up at release time.

### Added

- **`pmk gateway audit [--days N]`** ([#24](https://github.com/hanfour/pm-workspace-kit/issues/24)) — operator-facing rollup of recent knowledge-loop activity: per-user / per-audience turn breakdown, mra-ask success/retry/fail split with median duration, escalate triggered / absorbed / pending counts and median time-to-IT-reply, atom corpus stats with top contributors, plus flags for stuck pending atoms (> 24h) and stale escalations (> 48h). Window defaults to 7 days; `--days` accepts 1–365.
- **`~/.pmk/gateway/events.log`** — append-only JSONL ledger for the four event types the audit consumes (`turn.processed`, `mra-ask.end`, `escalate.triggered`, `escalate.absorbed`). Mirrors `admin.log` in shape and contracts; tolerant reader skips malformed lines.
- **Live mra-ask progress in Slack** ([#22](https://github.com/hanfour/pm-workspace-kit/issues/22)) — `runMraAsk` now uses `spawn` instead of `execFile` so each stdout line streams into the placeholder message via a 3-second last-line-wins throttle. The 30–90s mra round shows `[ask] PKB loaded`, `[ask] querying...` etc. tick by instead of a static spinner. `web.chat.update` rate well under Slack Tier 3; trailing fire cancelled on completion so a late progress line can't briefly overwrite the synthesised reply.

### Notes

- Audience binding is captured at turn time, so changing `audience default` after the fact does not rewrite the audit's history.
- Atom corpus stats (`total`, `approved`, `pending`, `topContributors`) are intentionally lifetime, not window-scoped — atoms persist in `~/.pmk/knowledge/` across windows.

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
