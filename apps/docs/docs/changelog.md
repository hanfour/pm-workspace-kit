---
sidebar_position: 99
---

# Changelog

All notable changes to **pm-workspace-kit** are documented here.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each release also has a longer narrative on [GitHub Releases](https://github.com/hanfour/pm-workspace-kit/releases) with rationale, dogfood notes, and test plans.

## [v0.32.0] — 2026-07-17 — `:a:` GitHub approve unlocked: cross-process authorization lock, live-verified

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.32.0)

### Added

- **First quarterly atom audit (2026-Q3)** ([#62](https://github.com/hanfour/pm-workspace-kit/issues/62)) — ran the playbook against real organic telemetry (n=2): 1 load-bearing atom (reuse 35/79d), zero questioned/dead-weight/stale, v0 thresholds deliberately retained (tuning on n=2 fits noise; re-calibrate at ~15–20 atoms or 2026-Q4). Real finding: **absorb-rate, not corpus quality, is the loop's bottleneck**. Audit history now lives in the playbook.
- **`:a:` GitHub approve re-enabled behind the cross-process authorization lock** ([#90](https://github.com/hanfour/pm-workspace-kit/issues/90)) — implements the precondition PR #70's release veto documented: config writers (`saveGatewayConfig`) and the approve POST critical section (`publishApprovalReservation`) now share one mkdir-based cross-process lock (`gateway/authorization-lock.ts`, dead-pid + stale-hold takeover via atomic rename-to-tombstone), closing the TOCTOU where a policy revocation could land between the last revision-fence read and the GitHub mutation. Same-process writers fail fast with an honest ":hourglass: approve 進行中" reply instead of starving the event loop; foreign-process writers block briefly. `AUTOMATIC_APPROVAL_RELEASE_READY` flipped to `true` — the runtime gate is now `review.approval.enabled` (admin-togglable via `/pmk admin review approval enable`, default **false**). The three-phase revision fences stay as defense-in-depth. +9 tests (7 lock, 2 acceptance: end-to-end gated approve; write-refused-inside-critical-section), 1,020 cli tests green.
- **Live-verified end-to-end (2026-07-17, sandbox)**: admin `approval enable` → `:cr:` on a ruleset-protected sandbox PR → thread `approve` → **real GitHub APPROVE** (review #4719101130, sha-pinned commit `2164c4b3`, MRA-artifact-bound body) → second `approve` correctly refused (offer consumed, exactly-once on disk). The verification surfaced and fixed two real preflight bugs the unit fakes could never catch: (1) the offer's `updatedAt` pin was invalidated by our own protocol-v1 review post — preflights now pin `headSha` + `baseRef` only; (2) `approvalProtectionReady` used the ADMIN-only classic-protection endpoint, a permanent 404 for the read-only pinned identity — it now probes the **Rules API** first (read-accessible; note classic protection does NOT surface there, only rulesets do).
- **OneAD production rollout still needs org decisions** (tracked in #90's closing note): a ruleset with dismiss-stale + require-last-push on target branches, and whether the bot identity gets write so its APPROVE counts toward required reviews. `review.approval.enabled` is back to **false** until then.

## [v0.31.0] — 2026-07-16 — Codex review provider, CI test harness, security hardening & hotspot decomposition

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.31.0)

### Added

- **Codex review integration** ([#70](https://github.com/hanfour/pm-workspace-kit/pull/70)) — PMK review now routes through the **MRA protocol v1** with **Codex as the default provider**. `:cr:` stays analysis/review-only; a true GitHub **APPROVE** remains gated behind a disabled-by-default approval policy. Adds admin/config surfaces for provider mode and review-approval gates, SHA-bound review artifacts, approval offers with a Slack confirmation flow, and `gateway doctor` coverage for the review provider. Depends on [multi-repo-agent#9](https://github.com/hanfour/multi-repo-agent/pull/9).
- **CI test workflow** ([#71](https://github.com/hanfour/pm-workspace-kit/pull/71)) — `test.yml` runs `npm test` (tsc typecheck + `node --test`) on every PR and push to `main`, across a matrix of all five workspaces with real suites (`cli` / `rag` / `shared` / `desktop` / `core`); the four `cli`/`rag`/`shared`/`desktop` jobs plus `core` are branch-protection required checks. Previously ~900 tests ran only on developer discipline.
- **`packages/core` test suite** ([#73](https://github.com/hanfour/pm-workspace-kit/pull/73)) — the two scripts CI actually executes (`traceability.js`, `confluence-sync.js`) went from **0 → 50 tests** (validation gate, graph build, label→status mapping, immutable status writes, Confluence API via mocked `fetch`), behind a behaviour-preserving `require.main` refactor.

### Fixed

- **Flaky traceability-check** ([#80](https://github.com/hanfour/pm-workspace-kit/pull/80)) — the generated matrix's `Last generated: <date>` line was its only volatile field, so any PR touching `traceability.js` on a later day failed the CI diff purely on the date. Dropped the stamp; matrix output is now deterministic.
- **Flaky atom-index staleness check** ([#89](https://github.com/hanfour/pm-workspace-kit/pull/89), closes [#83](https://github.com/hanfour/pm-workspace-kit/issues/83)) — the cache-validity check compared `builtAt >= newest atom mtime` exactly, so on coarse-mtime CI filesystems an atom written in the same tick as `builtAt` served a stale cache. Now: a 2s mtime tolerance window, plus the index records `fileCount` so the cache also invalidates on file-count changes — catching atom DELETIONS, which no surviving file's mtime can signal. The flaky test became three deterministic ones (added / edited-in-place / deleted).

### Changed

- **review.ts decomposition** ([#76](https://github.com/hanfour/pm-workspace-kit/issues/76)) — split the 1186-line hotspot into focused modules, re-exported from `review.ts` for back-compat (no import changes for callers), behaviour-preserving throughout:
  - _phase 1_: pure `:cr:`/`:a:` request classifiers → `review-requests.ts`; outcome types + Slack result-line formatters + `describeMraFailure` → `review-messages.ts`.
  - _phase 2_: the provider-facing backend seam of `runOne` → `review-backend.ts` — `buildReviewMraArgs` (pure argv), `runMraReviewWithRetry` (the transient-failure / REVIEW_INCOMPLETE retry policy), and `postProtocolV1Review` (codex protocol-v1 live-policy re-validation + GitHub post, returning a skip-or-status verdict the coordinator acts on). Now unit-testable in isolation: +13 backend tests.
  - `review.ts` 1186 → 1028 lines. The coordinator keeps the claim lifecycle, progress bar, and Slack replies; the extracted seam still warrants host live-verification of the end-to-end `:cr:`/`:a:` path before the next release.
- **admin.ts decomposition** ([#76](https://github.com/hanfour/pm-workspace-kit/issues/76)) — the `/pmk admin` dispatcher pulled its two largest command clusters into domain modules: `admin-review.ts` (`review …` provider/strategy/approval config) and `admin-audience.ts` (`audience …` per-user/channel/default tiers + v0.15 examples), over a shared `admin-shared.ts` (request/result types, `logAdmin`, the Slack-mention parsers) that breaks the dispatcher↔handler cycle. `admin.ts` 827 → 445 lines; `handleAdminSlash` behaviour unchanged (guarded by its existing 57 test call-sites, `extractUserId`/`extractChannelId`/`RuntimeHealthSnapshot` re-exported).
- **mra.ts decomposition** ([#76](https://github.com/hanfour/pm-workspace-kit/issues/76)) — pulled the review-protocol contract and the secret-strip out of the 1163-line adapter: `mra-env.ts` (`strippedChildEnv` + the secret-shaped-env denylist, shared by every mra spawn) and `mra-review-protocol.ts` (`MraReviewResult` / strategy+provider types, `buildReviewArgv`, `parseReviewStdout`, `reviewEnv` — pure, no spawning). `runMraReview` keeps the spawn wiring; both modules re-exported from `mra.ts` for back-compat. `mra.ts` 1163 → 1038 lines; behaviour-preserving (1009 cli tests, the argv/parse/env contract already had heavy coverage in mra-review.test.ts).
- **slack/index.ts decomposition** ([#76](https://github.com/hanfour/pm-workspace-kit/issues/76)) — beyond the v0.13–v0.14 extractions, pulled two more pieces out of the `SlackAdapter`: `slack-events.ts` (the ambient Socket-Mode payload types, now an exported `Slack` namespace) and `reaction-router.ts` (`routeReactionAdded` — the emoji→action dispatch for `:cr:`/`:a:`/📚/✅/❌/🎫/👎, taking the coordinators + web client as deps). `index.ts` 1314 → 1127 lines; behaviour-preserving, guarded end-to-end by slack-adapter.test.ts's `reaction_added` socket-emit tests. The remaining event handlers (message / app_mention / dm / slash-command) stay on the adapter — they warrant host live-verification before further extraction.

### Security

- **Atom title now injection-scanned + redaction hardening** ([#74](https://github.com/hanfour/pm-workspace-kit/issues/74)) — closes the four security follow-ups deferred at v0.29.0. The atom `title`/`question` is injected into retrieval context just like the body but was only redacted, never injection-scanned; a shared `scanAtomFields` now scans both fields on the audio (📚) and escalation save paths (same flag-not-block policy). `countHighEntropyTokens` recognises `=`-padded base64 secrets (was anchored on `\b`, which can't terminate on `=`). Phone redaction no longer over-matches 3-group numeric IDs / amounts / ticket refs (`1234 5678 9012`, `100-2000-3000`) — the domestic form now requires a trunk-prefixed (leading `0`) or parenthesised area code. Added a `glpat-` (GitLab PAT) redaction test.

### Verified

- Live PMK doctor: `passed=11 warned=1 failed=0`, `protocol=v1`, `provider=codex`, `strategy=standard`, `approval=disabled`; gateway launchd running, Slack socket connected; real MRA Codex protocol smoke complete/pass (0 findings, 0 blockers).
- All five CI test jobs green on real GitHub Actions.
- **Pre-tag live-Slack verify (2026-07-16, on the release build)**: `:cr:` end-to-end on onead/super-dsp-2.0#503 (CHANGES_REQUESTED, 2 comments, 1 blocker, 82s — exercising the decomposed review path + the mra reliability fixes); audio → summary → 📚 → **approved atom with permalink + retrieval-tuned title/tags** → next question answered from the atom (`atomsInjected: 1`, no mra-ask) — closes the #75 verification gap from v0.29.0. `:a:` correctly replies the `:lock:` release-veto notice (GitHub APPROVE stays disabled pending [#90](https://github.com/hanfour/pm-workspace-kit/issues/90)).

### Tests

- All workspaces: **1,119** (`cli` 1011 · `core` 50 · `shared` 32 · `rag` 13 · `desktop` 13).

---

## [v0.30.1] — 2026-07-06 — REVIEW_INCOMPLETE detection (exit-0 flaky-claude variant)

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.30.1)

### Why

A second `:a:` on a live PR (`onead/erp#4899`) reported the misleading "GitHub 未回報 approve 狀態…請至 PR 確認是否已 approve" — but the review had never actually completed. mra's single-pass claude emitted no completion sentinel, so mra **exited 0** while posting a neutral `REVIEW_INCOMPLETE` placeholder (GitHub event = COMMENT). The gateway parsed `status=COMMENT`/exit-0 as a normal success: the transient-retry (keyed on `!res.ok`) never fired, and the verdict fell through to the ambiguous approve line. This is the same flaky single-pass claude the `code=1` retry already guards — just the exit-0 variant.

### Fixed

- `parseReviewStdout` flags `incomplete` (the `REVIEW_INCOMPLETE` token is the only honest signal — the status line reads COMMENT), carried on `MraReviewResult`.
- `runOne` retries once on `incomplete` too (same backoff as the transient-failure path).
- Still incomplete after retry → route through `skip()`: **release** the per-commit claim (finalizing would reject a same-commit re-`:a:` as "already reviewed" and make the "請重試" advice a dead end) and report honestly ("review 未完成 … 未 approve … 請重試"), never the misleading ambiguous-approve line.
- Applies to `:cr:` too (shared `runOne`).

### Tests

- `@pmk/cli`: **947** tests (+5: parse flag, both result-text branches, retry-then-recover, retry-then-still-incomplete-with-claim-release), 100% pass.

---

## [v0.30.0] — 2026-07-06 — `:a:` approve + live Slack progress bar

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.30.0)

### Why

Ships the `:cr:`-review follow-ups: an `:a:` **approve-then-review** flow and a live Slack **progress bar** so the 30–90s review round shows movement instead of a static spinner — then a full review-fix + live-hardening pass and a security bump to zero npm-audit vulnerabilities.

### Added

- **`:a:` approve flow** — fast review → gated GitHub approve; parser (`isApproveRequest`), routing, retry-in-thread, honest three-way verdict reporting.
- **Live progress bar** — pure phase/pct/render functions, a change-gated `chat.update` timer that finishes (not freezes) on failure, correct analyze/strategy pacing.
- **`review.allowApprove` config** (default false) + `reviewEnv` wiring of `MRA_REVIEW_ALLOW_APPROVE` / `APPROVE_IF_NO_HIGH`.
- **`standard` single-agent review strategy** alongside debate/personas.

### Fixed

- **Security:** `reviewEnv` unconditionally strips approve-privilege env flags; a shared `strippedChildEnv` applies broad secret-stripping (`SECRET_ENV_RE`, incl. `PMK_SLACK_*`) to **all** mra subprocesses — review, analyze, and the previously-unstripped `mra ask` free-chat path.
- **Correctness:** approve verdict no longer inverts on mra's batch-fallback no-`status:` path; progress-bar tick/finish race fixed; analyze now fires on fresh PRs.
- **Reliability:** retry-once + backoff on transient mra failures with real-error surfacing (`describeMraFailure`).

### Verified

- `npm audit` = **0 vulnerabilities** — resolved all 7 advisories (2 high, 5 moderate) via same-major overrides (form-data, http-proxy-middleware, webpack-dev-server, dompurify, gray-matter>js-yaml, undici) with a full lockfile regen, no runtime/API surface change.
- Live: gateway restarted on the fresh build, Slack socket connected, keep-awake bound to the new pid; `mra ask` free-chat verified working under `strippedChildEnv`.

### Tests

- `@pmk/cli`: **942** tests, 100% pass.

---

## [v0.29.0] — 2026-07-02 — audio summary → knowledge atom (📚) + KB-wide injection defense & membership-gated retrieval

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.29.0)

### Why

Audio meeting summaries (v0.28.x) were thread-only — `mra-ask` couldn't find them and there was no durable link back. This makes a summary saveable to the knowledge base on demand, and hardens the whole atom corpus against two risks that saving richer content exposes.

### Added

- **📚 react-to-save** — react 📚 (`:books:`) on a posted audio summary → it becomes an **approved** `KnowledgeAtom` (permalink in front-matter, uploader/admin-gated, deduped by thread, atom id in the reply) that `mra-ask` retrieves. One atom per meeting; the summarizer now emits a retrieval-tuned `title`+`tags` in its existing LLM call (zero extra cost). Ephemeral `audio-atom` marker + atomic rename-mutex; `saveAtom` is now atomic (tmp+rename).
- **Injection defense (system-wide, all atoms)** — `formatAtomsForInjection` reframed so retrieved atoms are **untrusted reference data, not instructions**; `scanForInjection` heuristic flags directive content at save (audio **and** escalation atoms); `redactSecrets` broadened (AWS/GitHub/GitLab/Google keys, email, phone).
- **Membership-gated retrieval (system-wide)** — before injection, free-chat filters retrieved atoms by the querying user's channel access: **public → all, private/IM/mpim → members only, error → fail-closed**; cached (5-min TTL). Gates the whole corpus at the single injection chokepoint.

### Verified

- Full suite **888/888**, typecheck clean. Built via subagent-driven TDD (10 tasks, each spec+quality reviewed), shaped by a 6-agent design panel, gated by a whole-branch **opus** review.
- Two opus-review **must-fix** issues resolved before merge: a **fail-open** membership gate for DM/IM-origin atoms (`is_im` has no `is_private` → was classified public → could leak corpus-wide; now "public" is a positive `is_channel && !is_private` assertion), and an unrecoverable save-failure retry (marker now restored so 📚 retry works).

### Notes

- The 📚 save path is unit-tested + reviewed but **not yet Slack-live-verified** at tag time.
- Deferred follow-ups (opus-triaged): `countHighEntropyTokens` `=`-padding, `glpat-` test, phone over-redaction, atom title injected-but-not-injection-scanned, a few test-fixture/naming polish items.

### Tests

- `@pmk/cli`: **888** tests, 100% pass.

---

## [v0.28.1] — 2026-06-29 — audio long-file fixes (whisper-1, quota refund, monthly cap, diagnosability)

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.28.1)

### Why

Live testing of a real **45-minute** meeting recording exposed three issues the 8-second clip hadn't: long files failed to transcribe, failed attempts silently consumed the daily quota, and the failure reason wasn't recoverable from logs.

### Fixed

- **Default model → `whisper-1`.** `gpt-4o-mini-transcribe` is GPT-4o-based with a ~25-min token cap → `400 input_too_large` on long recordings (root-caused live; whisper-1 transcribed the same 45-min / ~5MB file in ~2 min). whisper-1 is bounded only by the 25MB request size, which the 16 kHz-mono re-encode satisfies — consistent with the existing size-based chunking.
- **Quota refund leak.** A single-chunk *total* failure emitted a gap-marker-only `partialTranscript`, which made the coordinator treat it as "cost incurred → don't refund" → reserved minutes leaked (two failed 45-min attempts ate 90 phantom minutes and tripped the daily cap). `transcribe` now returns `partialTranscript` only when a segment actually succeeded; total failures refund. Refunds target the **reserve-time** day/month bucket, so a job crossing a period boundary refunds the file it charged.
- **Failure diagnosability.** The underlying transcribe failure (HTTP status + code, e.g. `400 input_too_large`) is surfaced into the `audio.failed` event reason.
- **Cost estimate.** `USD_PER_MINUTE` 0.003 → 0.006 (whisper-1 list price) so `audio.transcribed.estimatedUsd` is accurate.

### Added

- **Optional whole-workspace monthly budget cap** — `audio.quota.globalMonthlyMinutes` with a monthly accumulator file; always tracked (so releases refund it), enforced only when configured.

### Verified

- Live: a 45-minute file transcribes end-to-end on whisper-1 (`audio.transcribed durationSec=2736 chunks=1 ms=132359` → `audio.summarized mode=long`).
- Code-reviewed (subagent): one MEDIUM (month-boundary refund) found, fixed, and covered by a cross-month test.

### Tests

- `@pmk/cli`: **847** tests, 100% pass (+ monthly cap incl. cross-month refund, total-failure-no-partial, failure-detail capture, whisper-1 default).

### Notes

- Cost (OpenAI bills in USD): whisper-1 $0.006/min. This deployment runs per-user 600/day, global 1800/day, **global 7500/month (≈ NT$1,485)**.

---

## [v0.28.0] — 2026-06-29 — Slack audio transcription → summary → planning

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.28.0)

### Why

Let meeting recordings and live audio clips flow through the gateway: upload or record audio in Slack → transcribe → auto-summary with a proactive next-step → continue planning / requirement-clarification in-thread with the uploader.

### Added

- **Audio pipeline** (`packages/cli/src/gateway/audio/`) — a detached coordinator (mirrors the `:cr:` ReviewCoordinator pattern): `categoryFor` routes audio → `claimAudio` → `🎧 轉錄中…` ack → stream-to-temp → ffmpeg probe → too-long gate → quota gate (actual minutes, before any API cost) → OpenAI transcription (ffmpeg re-encode to 16 kHz mono + byte-budget chunking for the 25MB limit) → raw transcript stored as thread context → signal-proportionate summary (short clip vs full PM-structured `long` mode) → posted in-thread.
- **Config** (`audio` block) — dark-launchable (`enabled:false` default) + first-use consent; OpenAI key via `{env}`/`{cmd}` SecretSource (never stored in config); `maxDurationSec` (2 hr cap); per-user / global daily quota.
- **Resilience** — abort + drain on shutdown (in-flight jobs post a `retry` notice), claim self-heal, secret redaction, prompt-injection framing, `retry` re-run from the thread.

### Fixed

- **Audio classification by filename extension** (#66) — a voice-memo `.m4a` arrived with sparse Slack metadata and `categoryFor` (mimetype/filetype only) returned "unsupported", so it never reached transcription. Added an `AUDIO_EXTENSIONS` fallback on the file name.

### Verified

- Live end-to-end: an 8-second clip → transcript → short summary (`audio.transcribed` + `audio.summarized` events).

### Tests

- `@pmk/cli`: **840** tests, 100% pass.

---

## [v0.19.0] — 2026-06-03 — gateway keep-awake hardening (throttle-proof + self-heal watchdog)

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.19.0)

### Why

The v0.18.0 demo smoke uncovered a silent multi-day gateway outage: a backgrounded daemon was App-Nap/sleep-throttled on macOS, starving Slack Socket-Mode's ping/pong (5 s window) — the socket reconnected endlessly but never stayed healthy, while the process stayed alive and the heartbeat kept ticking, so nothing looked wrong and the bot answered no one. This release makes that failure mode impossible-by-default and self-healing, and turns any residual unrecoverable state into a loud, alerting exit instead of a silent zombie.

### Added

- **Throttle-proofing** — [`keep-awake.ts`](https://github.com/hanfour/pm-workspace-kit/blob/main/packages/cli/src/gateway/keep-awake.ts). On macOS, `pmk gateway start` now holds a `caffeinate` power assertion bound to its own pid (`-w <pid>`, auto-released on death) for its whole lifetime, so a backgrounded daemon can't be throttled into starving the socket. Default flags `-is` (idle+system sleep; deliberately not the heavier `-dimsu` that holds the display awake — that remains available via `PMK_GATEWAY_CAFFEINATE_FLAGS`). No-op on non-macOS. Best-effort: a spawn failure never blocks startup.
- **Self-heal watchdog** — a pure [`SocketHealth`](https://github.com/hanfour/pm-workspace-kit/blob/main/packages/cli/src/gateway/socket-health.ts) tracker (fed by a pong-timeout tap [logger](https://github.com/hanfour/pm-workspace-kit/blob/main/packages/cli/src/gateway/slack/socket-logger.ts) + the five real SDK conn-state events) drives a [`SocketWatchdog`](https://github.com/hanfour/pm-workspace-kit/blob/main/packages/cli/src/gateway/slack/socket-watchdog.ts) (30 s ticks). On a wedged socket (≥3 pong-timeouts/60 s, or not `connected` past 60 s) it forces an in-process reconnect (time-boxed at 45 s so a hung reconnect can't pin the guard). A reconnect counts as failed only if the socket goes unhealthy again before 3 min of continuous health; after 3 confirmed failures the next unhealthy tick performs a **loud exit**.
- **Loud exit** — `PresenceBroadcaster.watchdogTerminate` records a `gateway.offline` (`reason: watchdog-unhealthy`, `broadcast:false` — an operator alert, not a stakeholder fan-out), DMs each `config.admins` (via `conversations.open`, over HTTP which works even when the WebSocket is dead) under a hard 15 s cap, then `process.exit(1)` — guaranteed even if the alert hangs or rejects. With no admins configured, the offline event + terminal log are the alert.

### Fixed

- Removed a dead `socket.on("reconnect", …)` listener in the Slack adapter (the SDK emits `reconnecting`, never `reconnect`).

### Tests

- `@pmk/cli`: **506** tests, 100% pass. New suites: `socket-health`, `keep-awake`, `socket-logger`, `socket-watchdog`, `socket-watchdog-alert`. Listener-survival-across-reconnect verified against the installed SDK source in a holistic review.

### Notes

- Host live-sanity (caffeinate child present, clean Ctrl+C shutdown) is an operator check, not covered by unit tests.
- Deferred: launchd/systemd service + boot auto-start; a `watchdogAlertChannelId` for channel (vs admin-DM) alerts; adaptive thresholds.

---

## [v0.18.0] — 2026-06-03 — adoption metrics + AcmeAds vertical demo (P4 · P5)

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.18.0)

### Why

Two priorities-plan strands land together. **P4 (adoption metrics)** answers "is anyone actually using this?" from local signals, so the kit's value can be judged without guessing. **P5 (vertical demo bundle)** gives a new operator a concrete, self-contained way to *watch* the knowledge loop work end-to-end on a fictional ad-tech workspace (AcmeAds), rather than reasoning about it abstractly.

### Added

- **`pmk adoption`** (P4) — [`packages/cli/src/adoption.ts`](https://github.com/hanfour/pm-workspace-kit/blob/main/packages/cli/src/adoption.ts). A pure report builder over the audit window, telemetry sidecar, atom corpus, and run markers ([`run-markers.ts`](https://github.com/hanfour/pm-workspace-kit/blob/main/packages/cli/src/run-markers.ts), `~/.pmk/adoption.json`): five clamped metrics (first-run / first-PRD markers, atom reuse rate, questioned rate, active-window turns).
- **AcmeAds demo content** (P5a) — [`acme-ads-seed.ts`](https://github.com/hanfour/pm-workspace-kit/blob/main/packages/cli/src/gateway/acme-ads-seed.ts): five approved AcmeAds atoms (ad placements, vCPM, customer migration, finance terms, an onboarding dedup rule), tagged `acme-ads-demo`, seeded/unseeded idempotently via `pmk demo seed` / `unseed`.
- **`pmk demo run`** (P5b) — [`commands/demo.ts`](https://github.com/hanfour/pm-workspace-kit/blob/main/packages/cli/src/commands/demo.ts) + [`demo-runner.ts`](https://github.com/hanfour/pm-workspace-kit/blob/main/packages/cli/src/gateway/demo/demo-runner.ts): posts the five guided questions as a real user (one-time `PMK_DEMO_USER_TOKEN`, `chat:write` only), correlates each `turn.processed`, and prints a Q→A transcript. Reply-readback uses the gateway **bot** token's `conversations.replies` (bot replies are always threaded). `--dm` / zero-config DM auto-open targets the bot DM (uses `im:history`); `--channel` targets a channel (needs the bot's `channels:history`). `--dry-run` previews.
- **AcmeAds demo walkthrough** (P5c) — [`examples/acme-ads-demo.md`](https://github.com/hanfour/pm-workspace-kit/blob/main/apps/docs/docs/examples/acme-ads-demo.md): a ~15-minute "watch the loop" guide, leading with the zero-credential manual DM path.

### Fixed

- Demo `readReply` no longer silently swallows `conversations.replies` failures — a missing bot scope (e.g. `missing_scope` for `channels:history` in a public channel) now surfaces in the transcript instead of a generic "did not stabilise".

### Verified

- The knowledge loop was verified **live** end-to-end on the host: a `pmk demo run` against the seeded AcmeAds corpus produced five `turn.processed` events with the correct atoms injected, the right audience tier, and the Q5 escalation boundary (`hadMraAsk`), with grounded answers. The automated transcript-capture additionally depends on the bot's reply-read scope (`im:history` for DMs / `channels:history` for channels) and on Slack delivering the demo user's messages — documented in the walkthrough's troubleshooting note.

### Tests

- `@pmk/cli`: **483** tests, 100% pass.

---

## [v0.17.0] — 2026-05-30 — atom usage telemetry (P2a)

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.17.0)

### Why

As the PKB grows, approved atoms need to stay high-signal and low-signal atoms need to become visible and removable (priorities-plan P2). That judgment can't be made without data on which atoms actually get reused and which get questioned after they're cited. v0.17.0 ships the **telemetry instrumentation** — the measurable foundation. The approver rubric + quarterly audit playbook (P2b) are deliberately deferred until real telemetry accumulates, so the rubric isn't written in a vacuum.

### Added

- **Atom telemetry sidecar** — [`packages/cli/src/gateway/atom-telemetry.ts`](https://github.com/hanfour/pm-workspace-kit/blob/main/packages/cli/src/gateway/atom-telemetry.ts). `~/.pmk/gateway/atom-telemetry.json` is the authoritative per-atom counter store (`reuseCount`, `lastRetrievedAt`, `questionedCount`, `lastQuestionedAt`). Bumps are **synchronous** (race-free under the daemon's parallel turns — a sync load-modify-save runs to completion before any other callback interleaves) and **crash-safe** (temp-file + rename), and are failure-isolated so telemetry can never break a turn or a reaction. The dedupe ledger is bounded (`QUESTIONED_KEYS_CAP`).
- **Citation linkage on `turn.processed`** — the event now carries optional `atomIds` / `channelId` / `threadTs` / `replyTs`, so a later 👎 or escalation can be mapped back to the atoms a reply cited. Atom `.md` files are never touched (the BM25 mtime index is never invalidated by telemetry).
- **`pmk gateway atoms telemetry [--json]`** — joins the sidecar with the approved corpus, lists each atom's reuse/questioned counts + age, sorted weakest-first, flagging **dead-weight** (never reused) and **load-bearing** (high reuse, no questions). Kept separate from `gateway audit` (runtime-health window) on purpose.

### Instrumentation

- **Reuse** is bumped at LLM success (next to the `turn.processed` emit), never on a failed turn.
- **Questioned** is bumped from a 👎 (`-1`/`thumbsdown`) on a cited reply (`x` stays reserved for pending-atom approval-reject) and from an escalation in a turn that injected atoms. Both paths dedupe (`reaction:…` / `escalate:…` keys) against Slack retries / re-reactions.

### Tests

- `@pmk/cli`: 446 → **459**, 100% pass. New `gateway-atom-telemetry` suite (sidecar, dedupe, cap eviction, runner wiring, report builder) + reaction/event coverage. Verified live on the host daemon: a cited DM bumped `reuseCount` to 1 and surfaced in `atoms telemetry`.

### Deferred (P2b)

- Approver rubric ADR + quarterly atom audit playbook — gated on accumulated real telemetry. `questionedKeys` pruning, telemetry-as-ranking-input, and a `gateway audit` summary line are future work.

---

## [v0.16.0] — 2026-05-29 — gateway onboarding (manifest · doctor · dry-run · demo seed)

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.16.0) · [PR #59](https://github.com/hanfour/pm-workspace-kit/pull/59)

### Why

Through v0.15 the gateway worked, but standing one up meant reading the source: `init` recited OAuth scopes line by line, there was no way to tell whether tokens / keys / mra workspace were actually wired before the daemon hit Slack, and the only way to test the retrieval → LLM → escalation path was to post real messages into a real channel. [PRD-2026-0006](./prds/2026-05-gateway-onboarding-prd.md) reframes the goal to one sentence: *a clean machine, without reading source, gets a bot answering in ~30 minutes.* v0.16 ships the five onboarding surfaces (FR1–FR5) plus the M6 baseline trial that the PRD's quality gate requires.

### Added

- **Slack app manifest** (FR1) — [`packages/cli/src/gateway/slack/manifest.template.json`](https://github.com/hanfour/pm-workspace-kit/blob/main/packages/cli/src/gateway/slack/manifest.template.json) carries every required bot scope + event subscription. `MANIFEST_VERSION = "2026-05"` lives in [`manifest-version.ts`](https://github.com/hanfour/pm-workspace-kit/blob/main/packages/cli/src/gateway/slack/manifest-version.ts) (deliberately **not** inside the JSON, so Slack's schema doesn't reject the upload). `gateway init` now prints the manifest path + `api.slack.com/apps?new_app=1` instead of reciting scopes.
- **`pmk gateway doctor`** (FR2) — 8 read-only preflight checks (config-file mode 0600, Slack app + bot tokens via live `auth.test` / `apps.connections.open`, Anthropic echo, mra workspace, PKB content, channel ACL, manifest alignment). FAIL → exit 1; `--json` for CI / hooks. Each check is its own sub-module under [`doctor-checks/`](https://github.com/hanfour/pm-workspace-kit/tree/main/packages/cli/src/gateway/doctor-checks) so new failure modes add a file, not a branch.
- **`pmk gateway start --dry-run`** (FR3) — wraps the Slack `WebClient` at the outermost layer ([`dry-run-wrapper.ts`](https://github.com/hanfour/pm-workspace-kit/blob/main/packages/cli/src/gateway/slack/dry-run-wrapper.ts)); every write (`chat.postMessage` / `postEphemeral` / `reactions.add`) is intercepted, logged as a stub, and never sent. Events route to `dryrun-events-YYYY-MM.log`; Ctrl+C prints session metrics. Interception is centralized so no caller can forget to skip.
- **`pmk gateway demo seed|unseed`** (FR4) — seeds one `source: "demo-seed"` atom + a `demo-onboarding` channel allowlist entry so a new host can smoke-test the full retrieval chain, then `unseed` removes exactly what it added (symmetric, no residue).
- **Onboarding guide** (FR5) — [`gateway/onboarding.md`](https://github.com/hanfour/pm-workspace-kit/blob/main/apps/docs/docs/gateway/onboarding.md): a 30-minute sequence (manifest → tokens → init → doctor → demo seed + dry-run → go live), cross-linked with the README and `gateway/lifecycle.md`.

### Hardened (M6 trial finding)

- **`pkb-content` now FAILs on an empty PKB whose source can't fill it.** The M6 four-failure trial found the empty-PKB mode slipped through: the check only inspected config *shape*, so a gateway pointed at an mra workspace with 0 repos passed as a soft WARN and `doctor` exited 0. It now counts approved atoms on disk (read-only, new `atomCount` runner defaulting to `approvedAtomCount()`) and FAILs only when the source provably can't seed it (mra source with 0 repos / unreachable workspace, or `mra:` ingest with no `mraWorkspace`). A fresh-but-viable install (0 atoms, repos ≥ 1) stays a WARN — no false positive on clean installs.
- **`llm-provider` check (was `anthropic-key`) recognizes the claude-agent OAuth path.** The check tested only a raw Anthropic API key and FAILed (exit 1) when none was set — but `resolveProvider` falls back to the local `claude` login (claude-agent SDK / OAuth) when no key is present, so doctor was **false-FAILing a valid OAuth-only host** and blocking startup. It now mirrors the runtime resolution (`PMK_PROVIDER` → CLI `config.provider` → `auto`): in auto mode a key wins (echo-verified), else a present `claude` binary PASSes, else FAIL. New `claudeCli` runner + `llmProvider` on `DoctorContext`.

### M6 baseline (PRD-2026-0006 §9 quality gate)

The four runtime-blocking failures the gate demands we deliberately provoke — expired App-Level Token, nonexistent mra workspace, empty PKB, stale manifest — were each driven through `runDoctor` against the real checks:

| Failure mode | doctor verdict | exit | actionable hint |
|---|---|---|---|
| Expired App-Level Token | FAIL `slack-app-token` | 1 | regenerate at api.slack.com → App-Level Tokens |
| Nonexistent mra workspace | FAIL `mra-workspace` | 1 | verify path + `.collab/repos.json` |
| Empty PKB (0 atoms, 0 repos) | FAIL `pkb-content` | 1 | register repos, re-run doctor |
| Stale manifest (missing scope) | FAIL `manifest-alignment` | 1 | add the named scope to `oauth_config.scopes.bot` |

- **Doctor coverage: 4/4 (100%).** Pre-hardening it was 3/4 — empty PKB was the gap, now closed. The trial also surfaced (and fixed) the `llm-provider` OAuth false-FAIL above.
- **Live preflight, real environment → ready, exit 0.** `pmk gateway doctor` run against the maintainer's actual OAuth-only setup: real Slack tokens (team `slack-webhook`), **63 mra repos**, `PKB has 1 approved atom`, and `llm-provider` PASS — *"no API key set — will use local claude login (claude-agent SDK)"*. **7 pass / 1 warn (DM-only) / 0 fail.** No `ANTHROPIC_API_KEY` needed: the gateway runs on the host's existing `claude` login.
- **Live first-message turn confirmed (real host, OAuth, no key).** A DM to the running production bot drove the full path end-to-end: socket-mode receive → retrieval (`atomsInjected: 1`) → `audience: tech` (per-user override) → LLM turn via the local `claude` login → reply posted to Slack (*"在線，v0.16 gateway-DM 就緒。"*) + `reactions.add`, with `turn.processed` logged server-side. This is the decisive proof that the runtime LLM path needs no API key — the doctor `llm-provider` PASS is backed by a real turn.
- **Time-to-first-message: deferred, not faked.** The metric measures how long a *fresh operator who hasn't seen the source* takes — a number neither the maintainer (knows it cold) nor an automated agent (unrealistically fast, non-representative) can produce honestly. Baseline is deferred to the first real external onboarding rather than recording a misleading figure. See the PRD metrics note.

### Tests

- `@pmk/cli`: 371 → **446**, 100% pass. New / extended suites: `gateway-manifest`, `gateway-doctor` (every check PASS + FAIL path, including the new empty-PKB atom-count branches and the llm-provider auto/anthropic-api/claude-agent matrix), `gateway-dry-run`, `gateway-demo-seed`.

### Out of scope / backlog

- **Polished AcmeAds demo bundle** — priorities-plan P5. M4 ships only a smoke-test seed.
- **Atom quality rubric / telemetry** — priorities-plan P2, gated on this baseline.
- **Doctor auto-fix** — PRD §4 non-goal; doctor stays read-only forever.

---

## [v0.15.0] — 2026-05-21 — workspace-configurable audience domain examples

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.15.0)

### Why

v0.13.3 expanded the BIZ jargon cheat-sheet to 9 rows + 2026-05-20's v0.14.0 added a meta-rule reframing the cheat-sheet's last row (`AdFormat` / `placement` / `inventory`) and the PM example table (`vCPM` formula, `placement_id`, `PlacementRevenue` vs `AccountPayable`) as "from an ad-tech reference workspace; apply the discipline to your own domain". The reframe stops the bot from inventing ad-tech context unprompted, but it doesn't teach non-ad-tech workspaces what their *own* domain vocabulary should translate to — operators ended up either tolerating English terms in body text or forking the shared package to swap in domain-specific rows.

v0.15.0 closes that loop with a runtime extension point: `cfg.audience.domainExamples.{biz,pm}` carries per-workspace `{ techForm, targetForm }` rows that `pickGatewayPrompt(audience, extras)` appends to the BIZ / PM cheat-sheet at assembly time.

### Added

- **`pickGatewayPrompt(audience, extras?)`** ([`packages/shared/src/index.ts`](https://github.com/hanfour/pm-workspace-kit/blob/main/packages/shared/src/index.ts)) — back-compat default (no extras → returns the base const unchanged for v0.7+ callers). With BIZ extras: appends a `Workspace-specific terms` block + a `Tech form | Plain-Chinese form` table. With PM extras: appends a `Workspace-specific examples` block + `Tech form (don't ask this way) | PM form (ask this way)` table. Tech / exec tiers ignore extras (no translation tables in those prompts).
- **`AudienceConfig.domainExamples`** ([`packages/cli/src/gateway/config.ts`](https://github.com/hanfour/pm-workspace-kit/blob/main/packages/cli/src/gateway/config.ts)) — `{ biz?: DomainExample[]; pm?: DomainExample[] }`. `loadGatewayConfig` back-fills the field on read so existing v0.7–v0.14 configs upgrade silently.
- **`pmk gateway audience example add|remove|list`** (CLI) and **`/pmk admin audience example add|remove|list`** (Slack) — admin commands to register translation rows at runtime. Slack syntax uses `=` as the separator so multi-word target forms survive whitespace tokenisation (`/pmk admin audience example add biz tenant = 客戶 / 訂閱戶`). Both surfaces re-key by `techForm` — adding a row that already exists updates instead of duplicating. Audit log records `audience.example.add` / `audience.example.remove` actions.
- **Wired through** at both prompt-assembly points: `FreeChatTurnRunner` ([`packages/cli/src/gateway/slack/free-chat-turn.ts`](https://github.com/hanfour/pm-workspace-kit/blob/main/packages/cli/src/gateway/slack/free-chat-turn.ts)) and `EscalationCoordinator` ([`packages/cli/src/gateway/slack/escalation.ts`](https://github.com/hanfour/pm-workspace-kit/blob/main/packages/cli/src/gateway/slack/escalation.ts)) now call `pickGatewayPrompt(audience, config.audience.domainExamples)`.

### Tests

- `@pmk/shared` 24 → **29** — `pickGatewayPrompt(audience, extras)` covered for: no-extras back-compat, BIZ table append, PM table append, tech/exec ignore extras, wrong-tier slot ignored.
- `@pmk/cli` 362 → **371** — Slack admin `audience example add/remove/list` covered for: append, multi-word target rejoin (`= 客戶 / 訂閱戶`), duplicate-techForm update-not-duplicate, unsupported-tier rejection, missing-`=` rejection, remove-not-found idempotency, list render, `loadGatewayConfig` back-fill from old shape.
- Total: 412 → **426** tests, 100% pass.

### Operator note

Same in-memory snapshot caveat as the rest of `audience`: edits via Slack admin or CLI write through to `~/.pmk/gateway.json`, but the running daemon keeps its in-memory snapshot until graceful restart:

```bash
kill -TERM $(cat ~/.pmk/gateway/gateway.pid) && pmk gateway start
```

Within the v0.11 marker window (5 min) the restart stays silent in Slack.

### Out of scope / backlog

- **Per-channel example overrides** — currently examples are workspace-scoped. If a host runs one Slack workspace that spans multiple distinct product domains (e-commerce in `#shop`, ad-tech in `#ads`), there's no way to tier examples by channel yet. Deferred until a real multi-domain workspace surfaces the need.
- **TECH-tier examples** — the tech prompt has no cheat-sheet to extend; if dogfood shows tech-tier replies also imprinting on ad-tech anchors, the next iteration would add a tech-specific addendum section. Not yet motivated by observed behaviour.

---

## [v0.14.0] — 2026-05-20 — SlackAdapter tranche 4 + post-v0.13.3 docs/prompt polish

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.14.0) · [PR #56](https://github.com/hanfour/pm-workspace-kit/pull/56)

### Why

Closes out the v0.13 SlackAdapter decomposition arc started in v0.13.0 (tranches 1–3: `presence` / `envelope-dedup` / `concurrency` / `escalation` / `free-chat-turn` / `inflight-queue`). After tranche 3 the adapter shell sat at 1043 lines — over the `<800` dispatcher-cleanup target set during v0.13 planning. Tranche 4 ships two more focused coordinators and folds in two small post-v0.13.3 backlog items that surfaced while sweeping for release.

### Fixed / Refactored

- **`slack/index.ts` 1043 → 734 lines** (closes the `<800` target). Adapter shell now == lifecycle (start / waitForPending / stop) + event-routing glue (handleMessage / handleAppMention / handleDmMessage / handleReactionAdded / handleSlashCommandEnvelope) + the ambient Slack-event types. Behavior unchanged; 412 / 412 tests still pass.
- **`slack/slash-command.ts` (new, 215 lines)** — `SlashCommandHandler` owns `/pmk <verb>` dispatch (`help` / `open` / `show` / `close` / `cases` / `admin`). Pure-helper `slashCommandArgsFromBody` and `SlashCommandScope` / `SlashCommandArgs` types move with it; `slack/index.ts` re-exports them so existing test imports (`gateway.test.ts`) keep working. Envelope-level glue (ack / dedup / blocklist / error logging) deliberately stays on `SlackAdapter.handleSlashCommandEnvelope` — those concerns are shared with every other Slack event type.
- **`slack/channel-mention.ts` (new, 180 lines)** — `ChannelMentionHandler` owns channel `app_mention` routing (slash forward / free-chat / case-mode LLM round + tracking summary). `SlashCommandHandler` and `FreeChatTurnRunner` injected via constructor so the dependency graph stays explicit.
- **`#1 channels-override docs catch-up`** — README quick-start and `lifecycle.md` deep-dive were missing the `set-channel` / `unset-channel` admin surface even though the feature shipped in v0.11.0 (#23) with full CLI + Slack admin coverage and 9 tests. Three small doc patches catch them up; resolution order at turn time now documented inline (per-user → per-channel → workspace default).
- **`#3 PM/BIZ ad-tech reframe`** — BIZ jargon table (`AdFormat` / `placement` / `inventory`) and PM example table (`vCPM` formula, `placement_id`, `PlacementRevenue` vs `AccountPayable`) were lifted from real OneAD-like dogfood. Both tiers now lead the relevant block with a workspace-context meta-rule: "the examples below are from an ad-tech reference workspace; apply the same translation discipline to your domain's terms — do not cite `AdFormat` / `placement` literally when they don't appear in the workspace." Workspace-configurable domain examples (`cfg.audience.domainExamples`) deferred to v0.14 backlog.

### Tests

`@pmk/cli` 362 → **362** (unchanged — refactor preserves behavior). `@pmk/shared` 24 → **24** including the "audience prompts have distinct bodies (cross-wire regression)" test which still passes after the BIZ + PM meta-rule additions.

### Live-Slack verify

Verified end-to-end on a real Slack workspace before tagging:

1. **DM `/pmk help`** → `handleDmMessage` → `slashCommand.run({scope: user})` — bot reply matches `case "help"` text exactly.
2. **Channel `@pmk /pmk help`** → `handleAppMention` → `channelMention.run` → slash forward → `slashCommand.run({scope: channel})` — bot reply matches `case "help"` text exactly. Confirms ChannelMentionHandler's `/pmk` forwarding branch.
3. **Channel `@pmk <free-chat>`** → `channelMention.run` (no slash prefix, no activeCase) → `freeChatTurn.run` — bot answered per prompt; `turn.processed` event emitted (`audience: tech`, `hadMraAsk: false`).
4. **BIZ-tier reframe** (temporarily removed user override to hit workspace default `biz`) — asked a non-ad-tech permission-control question; bot returned a 3-layer structural answer applying the cheat-sheet translations (`role` → 角色, `scope` → 歸屬關係 二次過濾) with zero ad-tech leak (`AdFormat` / `placement` / `inventory` never appear). Workspace-specific OneAD subsystem names (`ODM`/`OAM`/`SuperDSP`) DID appear because they are real workspace context, which is exactly what the reframe wants — meta-rule blocks unprompted cheat-sheet jargon insertion, not legitimate context references.

### Operator note

This is a refactor + prompt + docs release. No config migration needed. The gateway picks up new code on next graceful restart:

```bash
git pull && npm run -w @pmk/cli build
kill -TERM $(cat ~/.pmk/gateway/gateway.pid) && pmk gateway start
```

### Backlog (deferred to v0.14.x)

- **Workspace-configurable domain examples** — `cfg.audience.domainExamples` carrying per-workspace translation pairs + example questions, injected into BIZ/PM prompts at assembly time. Enables ad-tech workspaces to keep concrete `AdFormat` / `placement` anchors while non-ad-tech workspaces get their own domain vocabulary. Punted from v0.14.0 because the current single-workspace dogfood doesn't justify the new config surface + admin commands yet.

---

## [v0.13.3] — 2026-05-20 — gateway audience prompts: anti-bleed + BIZ translation table

[GitHub release](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.13.3)

### Why

v0.13.2 made `biz` the default — verification showed the biz reply was dramatically cleaner than pm (zero code blocks, plain-Chinese structure, business-meaning section). But two follow-ups from the same dogfood round:

1. **PM tier was leaking code blocks.** A 4-line Ruby `def`/loop snippet appeared in the PM-tier reply to "admin 權限的核心邏輯", even though the PM prompt's existing rule said "No code blocks unless quoting an exact API name or table column". Root cause: prior turns in the channel were tech-tier replies with full Ruby blocks; the LLM was tone-matching the conversation history, not strictly following the system prompt.
2. **BIZ translation cheat-sheet was thin.** Only 3 examples inline (`AdFormat` → 廣告版型, `scope` → 篩選條件, `AASM` → 狀態機). For Rails-stack workspaces the bot will see `Devise` / `Doorkeeper` / `Rolify` / `CanCanCan` / `Sidekiq` / `migration` etc. all the time; without explicit translations the LLM either keeps the English term or invents inconsistent translations across turns.

### Fixed

- **PM prompt: explicit "no multi-line code blocks" rule** (`packages/shared/src/index.ts`). The existing "No code blocks unless quoting an exact API name or table column" stays, but the new wording forces inline-backtick-only for names (`PlacementRevenue`, `app/services/foo.rb`, `is_admin_permission?`) and demands prose description instead of multi-line snippets: "Ability 用 dynamic dispatch — Rolify 表裡的角色名稱被當 method 名稱呼叫" replaces the 4-line Ruby loop.
- **PM + BIZ: anti-bleed guardrail.** Both prompts now lead with the same first rule: **"Your tier dictates style, not the conversation history. If prior turns in this thread used multi-line Ruby/SQL blocks, do not tone-match — they were for a different reader."** This counters the LLM's default behaviour of mirroring conversation tone when the audience tier silently changes mid-channel.
- **BIZ: 9-row jargon translation table** (was 3 inline examples). Covers common web-stack terms: `Devise`/`Doorkeeper`/OAuth/JWT → 登入機制 / 第三方授權登入, `Rolify`/role → 角色管理, `CanCanCan`/`ability.rb` → 權限規則, `scope` → 資料篩選條件, `AASM`/state machine → 流程狀態管理, `Sidekiq`/cron → 背景排程, `migration` → 資料表結構變更, `controller`/endpoint → 後台處理動作, `AdFormat`/placement → 廣告版型. Bot is explicitly told to never leave the tech form alone in body text.
- **BIZ: explicit "對業務的實際意義" section convention.** When the answer has operational implications, the reply ends with a 1–3 bullet section spelling out what the user should know (matches the pattern observed in the v0.13.2 verification round).

### Tests

`@pmk/cli` 362 → **362** (unchanged). Shared package's "audience prompts have distinct bodies (cross-wire regression)" test still passes — the four prompts are still distinct after the edits. All 412 workspace tests still pass.

### Operator note

This is a prompt-only change inside `@pmk/shared`. The gateway picks up new prompts on next start — no config migration needed. To apply on an existing host:

```bash
git pull && npm run -w @pmk/cli build
kill -TERM $(cat ~/.pmk/gateway/gateway.pid) && pmk gateway start
```

The anti-bleed guardrail's effectiveness is measurable: if you observe a PM-tier or BIZ-tier reply that still includes a multi-line code block AFTER this upgrade, file an issue with the Slack thread URL — the prompt isn't strong enough yet and we need another iteration.

---

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
  - **Net: -698 lines (-41%)** from the v0.12.0 baseline. Tranche 4 (dispatcher cleanup, target `<800` lines) is deferred.
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
