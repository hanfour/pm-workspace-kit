# Review Approve + Progress Bar — Design

- **Date:** 2026-07-03
- **Status:** Approved (design), pending implementation plan
- **Scope:** `pm-workspace-kit` gateway (Items 1, 2, 3a) + `multi-repo-agent` (Item 3b)
- **Trigger context:** A `:cr:` review of `onead/superdsp-ui#547` appeared "stuck" — it was
  actually a normal 3.5-min `debate` review with no in-flight Slack feedback. Investigation also
  surfaced that the gateway logged `status: APPROVED` while GitHub recorded `COMMENTED` (mra's
  intentional prompt-injection-safe downgrade). This design fixes the perceived-hang UX, makes AI
  approval actually land on GitHub, and adds an explicit review-then-approve command.

## Background / Root Cause

A `:cr:` reaction runs `mra review <project> --pr N --strategy debate` detached in an isolated
workspace (`~/.pmk/review-workspace`). The coordinator posts an immediate `:mag: 收到…` ack, then
nothing until the final `:white_check_mark: …` result 3–4 minutes later. The silent middle window
reads as "stuck".

Separately, mra deliberately downgrades an AI `APPROVED` verdict to a GitHub `COMMENT` unless the
operator opts in with `MRA_REVIEW_ALLOW_APPROVE=1` (see `multi-repo-agent/lib/review.sh`
`_review_event_for_status`). Rationale: the review Claude session reads untrusted PR code and could
be prompt-injected into approving malicious code, so its "approve" must never auto-satisfy a merge
gate without explicit opt-in. This is a security feature, not a bug — but the gateway/Slack surface
mislabels the result as "APPROVED".

## Goals

1. **Item 1** — Let an AI `APPROVED` verdict actually mark the PR approved on GitHub, gated behind an
   operator config opt-in (default off). Global opt-in stays **on** per owner decision.
2. **Item 2** — Replace the silent 3.5-min window with an in-place percentage progress bar in Slack.
3. **Item 3** — Add a `:a: <PR url>` command: run a fast single-agent code-review gate, then approve
   the PR iff no high-severity issue was found.

## Non-Goals

- No change to the `:cr:` review pipeline's analysis logic, workspace isolation, claim/self-heal,
  identity guards, or shutdown drain — all reused as-is.
- No new severity taxonomy — mra already emits `CRITICAL | HIGH | MEDIUM | LOW` per comment.
- No branch-URL → PR resolution (owner chose PR-URL input, consistent with `:cr:`).

---

## Item 1 — Config-gated real approve

**All changes in `pm-workspace-kit`; mra unchanged (it already reads `MRA_REVIEW_ALLOW_APPROVE`).**

- `ReviewConfig` (`gateway/config.ts`) gains `allowApprove: boolean` (default `false`).
  - `normaliseReviewConfig` parses `allowApprove` when boolean.
  - `resolveReviewConfig` defaults it to `false` (safe).
- `reviewEnv()` (`adapters/mra.ts`) sets `env.MRA_REVIEW_ALLOW_APPROVE = "1"` when the resolved
  config's `allowApprove` is true. Same insertion point as the existing `MRA_REVIEW_PERSONAS` /
  `MRA_REVIEW_AGENT_MAX_TURNS` env wiring. `allowApprove` is threaded from `resolveReviewConfig`
  through `runMraReview` opts into `reviewEnv`.
- **Effect:** mra's `_review_event_for_status` returns `APPROVE` → GitHub records `APPROVED` →
  `res.status` / `review.posted` event / Slack message become consistent.

**Verified precondition:** the pinned review identity (`HanfourHuangOneAD`) is **not** PR 547's
author — the two prior `CHANGES_REQUESTED` reviews landed as `CHANGES_REQUESTED` (GitHub blocks
request-changes on your own PR too), so a real `APPROVE` will not 422.

**Security note:** the review flow already refuses non-private repos (`allowPublicRepos` guard) and
honors `repoAllowlist`, so the injection exposure from enabling approve is bounded to private repos
the operator controls. This is a deliberate, owner-approved trade-off.

**Residual honesty gap (documented, deferred):** if GitHub still rejects the approve in some future
edge case (e.g., the bot becomes the PR author → 422), mra's `status:` stdout line still prints the
model verdict, so the gateway would again mislabel. A fully robust fix requires mra to emit the
*actual posted event*. Out of scope for this change; noted for a later follow-up.

---

## Item 2 — Slack percentage progress bar

**All changes in `pm-workspace-kit` gateway.**

### New module: `gateway/slack/review-progress.ts`

Single responsibility: manage the progress rendering of one Slack message. Small, isolated, and
unit-testable. Pure functions + a thin timer/update wrapper.

**Pure functions (unit-tested in isolation):**

- `phaseFromLine(line: string): Phase | undefined` — maps an mra `onProgress` stdout line to a
  phase. Recognized phases and their anchor floors:

  | Phase | Trigger substring (mra stdout) | Anchor floor % |
  |-------|--------------------------------|----------------|
  | `prepare` | initial ack / `reviewing <project>` | 5 |
  | `pkb` | `PKB available` / `updating PKB` | 20 |
  | `analyze` | `loaded existing PR discussion` (analysis begins) | 35 |
  | `posting` | `posting inline review` | 90 |
  | `done` | `review posted` | 100 |

- `computePct(phase, elapsedInPhaseMs, strategy): number` — returns the clamped percentage.
  For the long `analyze` phase, interpolates upward from the phase floor toward a cap
  (`ANALYZE_CAP = 85`) using an expected duration (`EXPECTED_ANALYZE_MS` per strategy;
  `debate ≈ 210_000`, `standard ≈ 90_000`). **Never returns 100 until `done`** — anti-freeze
  guarantee. Monotonic: never decreases.

- `renderBar(pct: number, phaseLabel: string): string` — e.g.
  `:mag: review onead/superdsp-ui#547\n▰▰▰▱▱ 60%\n目前:分析中(debate)`.
  Uses `▰` (filled) / `▱` (empty), 5 cells, `round(pct/20)` filled.

**Timer/update wrapper (integration-tested with fake `WebClient` + fake clock):**

- Constructed with `{ web, channel, ts, strategy, label }` where `ts` is the progress message's
  timestamp.
- `onPhase(line)` — feed each `onProgress` line; updates internal phase.
- Internal `setInterval` (~5s tick) recomputes `pct` (so `analyze` creeps) and calls
  `chat.update({ channel, ts, text })` **only when the rendered string changed** (skip no-op
  renders → well under Slack Tier-3 ~50/min even for a full run).
- `finish(finalText)` — clears the timer and `chat.update`s the message to the final result line
  (permanent record with PR link + status).
- `fail()` / `dispose()` — clears the timer (called from the `finally` block and shutdown drain).

### Wiring in `gateway/slack/review.ts`

- Add a `reply`-variant that returns the posted message `ts` (current `reply()` discards the
  `postMessage` response). Used to obtain the progress message's `ts`.
- Overall ack (`:mag: 收到,背景 review N 個 PR…`) stays as the immediate first message.
- **Per PR**: post an initial progress message, capture its `ts`, construct a `ReviewProgress`, feed
  `onProgress` lines into it, and on completion call `finish()` with the existing result text. On
  skip/error/abort, `dispose()` the timer.
- `drainOnShutdown` additionally `dispose()`s any live progress timer before posting the existing
  "interrupted by restart, reply `retry`" notice.

### Error handling

- `chat.update` failures are best-effort (swallowed + logged, mirroring `reply()`), so a transient
  Slack hiccup never breaks the review.
- If mra changes its stdout wording and a phase line is never matched, the bar simply holds at the
  last known phase's creep and still converges via `finish()` — degraded but not broken.

---

## Item 3 — `:a: <PR url>` review-then-approve

**Spans both repos.** Reuses every `:cr:` guard and the Item 2 progress bar.

### 3a. Gateway (`pm-workspace-kit`)

- **Trigger:** `isApproveRequest(text)` = `text.includes(":a:")` AND `parsePrRefs(text).length > 0`.
  Primary path is typed message (`fromMessage`), routed at the same layer as `isReviewRequest`.
  A `:a:` reaction on a message is also supported (parity with `:cr:` `fromReaction`) since the
  cost is low. If a message contains both `:a:` and `:cr:`, `:a:` (approve) wins.
- **Flow `approveOne`:** structurally mirrors `reviewOne` and reuses all its pre-post guards —
  `resolveProjectByRemote` → `resolveRepoSlug` → `getPrHead` → private-repo/`allowlist` guard →
  `claimReview` → workspace clone → `getAuthUser == expectedGhUser` → detached `runMraReview`
  (with Item 2 progress) → `finalizeReview` + `review.posted` event + Slack result → teardown.
  Differences from `reviewOne`:
  - `strategy = "standard"` (single-agent fast gate; **D1** — never escalates to debate).
  - `MRA_REVIEW_ALLOW_APPROVE = "1"` is forced **per invocation**, independent of the global
    `review.allowApprove` config (an explicit human `:a:` IS the opt-in).
  - `MRA_REVIEW_APPROVE_IF_NO_HIGH = "1"` (new policy flag, see 3b).
- **Config/type change:** widen the review strategy type from `"debate" | "personas"` to
  `"debate" | "personas" | "standard"` across `ReviewConfig`, `buildReviewArgv`, and `reviewEnv`.
  `buildReviewArgv` maps `"standard"` → `--strategy standard`.
- **Slack reporting** (via the Item 2 progress message's `finish()`):
  - Approved: `:white_check_mark: 已 approve <slug>#<n>(無重大問題;<m> 則 minor 建議):<url>`
  - Not approved: `:no_entry: 未 approve <slug>#<n> — 發現 <k> 個重大問題,已請求修改:<url>`

### 3b. mra (`multi-repo-agent/lib/review.sh`)

- New env-gated policy: when `MRA_REVIEW_APPROVE_IF_NO_HIGH=1` (AND approve is allowed), the review
  event is decided by **severity** instead of raw `status`:
  - `hasHigh = any(comment.severity ∈ {CRITICAL, HIGH})` — data already present in the validated
    review JSON.
  - `!hasHigh` → event `APPROVE` (approve-with-comments: `MEDIUM`/`LOW` nits are still posted).
  - `hasHigh` → event `REQUEST_CHANGES` (post the blocking issues). **(D2, D3)**
- Implemented near `_review_event_for_status` so all event-mapping stays in one place. The policy is
  inert unless the env flag is set, so `:cr:` behavior is unchanged.

### `:a:` decision defaults (owner-approved)

- **D1** fast gate = mra `standard` (single-agent), no debate escalation.
- **D2** "high-severity" = `CRITICAL` or `HIGH`; `MEDIUM`/`LOW` are minor and allowed through.
- **D3** high present → `REQUEST_CHANGES` (formal merge block); none → `APPROVE` with minor comments.
- **D4** typed `:a:` is primary; `:a:` reaction also supported.

---

## Testing (TDD)

- **Item 1:** `reviewEnv` sets/omits `MRA_REVIEW_ALLOW_APPROVE` under `allowApprove` true/false;
  `resolveReviewConfig` defaults `allowApprove` to `false`; `normaliseReviewConfig` parses it.
- **Item 2:** pure `phaseFromLine` / `computePct` (creep clamp, monotonic, **never 100 until done**)
  / `renderBar`; `ReviewProgress` with fake `WebClient` + fake clock — updates only on render
  change, `finish()` converges to 100% + result line, `fail()`/`dispose()` clears the timer.
- **Item 3:** `isApproveRequest` parsing (`:a:` + PR ref required; `:a:` beats `:cr:`);
  mra `review.sh` policy (`no-high → APPROVE`, `has-high → REQUEST_CHANGES`, flag-off → unchanged);
  gateway `approveOne` with fakes for both outcomes (approved vs request-changes) + guard reuse.

## Delivery

- **PR A (`pm-workspace-kit`):** Item 1 + Item 2 + Item 3a.
- **PR B (`multi-repo-agent`):** Item 3b (approve-if-no-high policy).
- Item 3a depends on 3b's env contract; land 3b (or at least fix its contract) first, or feature-gate
  `:a:` until 3b ships.

## Open Questions

- None blocking. Residual honesty gap (Item 1) and any richer per-severity Slack breakdown are noted
  as optional follow-ups.
