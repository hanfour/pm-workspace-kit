# Atom telemetry instrumentation — design (P2a)

**Date:** 2026-05-29
**Status:** Approved (design); implementation pending
**Source:** priorities-plan P2 — Atom 品質控制 ([`apps/docs/docs/plans/2026-05-product-priorities-plan.md`](../../../apps/docs/docs/plans/2026-05-product-priorities-plan.md))

## Context

As the PKB grows, approved atoms must stay high-signal and low-signal atoms must
become visible and removable. P2's *Signal of done* has three parts:

1. **Telemetry fields** — `reuse-count`, `last-retrieved-at`, `was-questioned-after-citation`.
2. **Approver rubric** (ADR) — when to approve / absorb-with-edit / reject.
3. **Quarterly atom audit playbook**.

Parts 2–3 need real onboarding traffic so the rubric is not written in a vacuum
(plan's explicit caveat). **This design covers only part 1 — the telemetry
instrumentation (P2a)** — which is the prerequisite the rubric *and* priorities-plan
P4 both depend on. The rubric/playbook (P2b) is deferred until telemetry has
accumulated real data.

## Goals

- Make per-atom usage measurable without touching the human-editable atom `.md`
  files or the mtime-based BM25 index.
- Capture three signals: `reuseCount`, `lastRetrievedAt`, `questionedCount`
  (+ `lastQuestionedAt`).
- Surface the data through a dedicated audit command that flags dead-weight vs
  load-bearing atoms.

## Non-goals

- **No retrieval-ranking change.** Telemetry is for visibility/audit, not for
  re-ranking retrieval (possible future, YAGNI now).
- **No rubric or quarterly playbook** (P2b, deferred — needs real traffic).
- **No retention/pruning policy** for telemetry (note as future).
- **Slack only.** Other platforms out of scope.
- **Atom `.md` files are not modified.** Telemetry never writes atom content.

## Data model

### Sidecar rollup (single source of truth for counters)

`~/.pmk/gateway/atom-telemetry.json`:

```jsonc
{
  "version": 1,
  "atoms": {
    "<atomId>": {
      "reuseCount": 0,
      "lastRetrievedAt": "2026-05-29T09:23:16.144Z",
      "questionedCount": 0,
      "lastQuestionedAt": null
    }
  },
  // Dedupe ledger — keys of questioned-events already counted, so retries /
  // re-reactions / remove+re-add don't inflate questionedCount. See §Dedupe.
  "questionedKeys": []
}
```

- atomId-keyed → O(1) read for the audit surface.
- The sidecar is the **authoritative counter store**; it is updated
  imperatively, not derived from events. No drift because it does not mirror the
  event log — it is the rollup.

### Citation linkage (in the event, not the sidecar)

Extend `TurnProcessedEvent` ([`packages/cli/src/gateway/events.ts`](../../../packages/cli/src/gateway/events.ts))
with optional fields:

```ts
atomIds?: string[];   // approved atoms injected into this turn
channelId?: string;
threadTs?: string;
replyTs?: string;     // Slack ts of the bot reply this turn produced
```

All optional → legacy events still parse. This event answers "which atoms did
this bot reply cite, and where did the reply land" — the linkage the questioned
paths need to map a 👎 / escalation back to atom IDs. The sidecar does **not**
carry this linkage (it only rolls up counters).

`FreeChatTurnRunner.run` already holds all four values at emit time (retrieved
atoms, channelId/threadTs, placeholder/reply ts), so no new plumbing is needed
to populate them.

## Instrumentation points

All three bumps go through one helper module so write semantics (atomic write,
in-process serialization) live in one place.

### Reuse bump — at LLM success, before `turn.processed` emit

In `FreeChatTurnRunner.run`, bump **after the LLM call succeeds and just before
the `turn.processed` emit (~line 283)**, NOT immediately after `searchAtoms`
(~line 146). A failed/aborted LLM call must not count an atom as reused.

For each injected atomId: `reuseCount++`, `lastRetrievedAt = now`. Same site
populates the extended `turn.processed` (`atomIds`, `channelId`, `threadTs`,
`replyTs`).

### Questioned bump — 👎 reaction on a cited reply

Extend `handleReactionAdded` ([`packages/cli/src/gateway/slack/index.ts`](../../../packages/cli/src/gateway/slack/index.ts)):

1. **Approval-anchor first** (unchanged): `findAtomByApprovalMessage` — `x` /
   approval reactions keep their current pending-atom approve/reject meaning.
2. **Else citation-feedback lookup**: if the reaction is the negative emoji
   (`-1` / `thumbsdown`) and the reacted `(channelId, messageTs)` matches a
   `turn.processed.replyTs`, bump `questionedCount` for that turn's `atomIds`.

`x` stays reserved for approval-reject; `-1` means "citation questioned" — no
semantic collision.

### Questioned bump — escalation in a turn that cited atoms

Done **in-place in the turn runner**, not via a cross-event lookback. The runner
emits `turn.processed` *after* it calls `escalation.escalate`, so at escalate
time the current turn's atoms are not yet on disk — a lookback would miss them
and grab a prior turn. Instead, where the runner has both `retrieved` (the cited
atoms) and the reply ts in hand: if the turn escalated **and** injected atoms
(`escReq && retrieved.length > 0`), bump `questionedCount` for the cited atoms.
This is the "model cited atoms yet still needed a human" signal, captured
exactly. Pushback that arrives as a *later* turn is covered by the 👎 path
instead. Dedupe key: `escalate:<channelId>:<threadTs>:<replyTs>`.

### Dedupe

Every questioned bump computes a dedupe key; if it is already in
`questionedKeys`, the bump is skipped:

- reaction: `reaction:<channelId>:<replyTs>:<userId>:<reaction>`
- escalate: `escalate:<channelId>:<threadTs>:<sourceTurnReplyTs>`

This neutralizes Slack event retries, the same user re-reacting, and
remove-then-re-add. `questionedKeys` is bounded by questioned-event volume
(rare); pruning is deferred (note as future).

## Read surface

New command **`pmk gateway atoms telemetry [--json]`**:

- Joins the sidecar with the approved-atom corpus.
- Lists each atom with `reuseCount`, `lastRetrievedAt`, `questionedCount`,
  `lastQuestionedAt`, sorted ascending by `reuseCount` then by oldest
  `lastRetrievedAt` so the weakest atoms surface first.
  - **dead-weight** — flagged when `reuseCount === 0` (never retrieved since
    instrumentation began). The `createdAt`-vs-now age is shown alongside so the
    operator can tell a brand-new atom from a long-ignored one; no hard age
    threshold is baked in (that judgment belongs to the deferred rubric).
  - **load-bearing** — flagged when `reuseCount` is high and `questionedCount`
    is 0; the exact cutoff is a render-time heuristic, not core logic.
- `--json` for scripts / the future quarterly playbook.

Kept **separate from `pmk gateway audit`** on purpose: `audit` is a
time-window runtime-health summary; telemetry is a cross-time corpus/knowledge-
quality view, and the sidecar is a current rollup (not an event-window). Folding
them would make `audit` a second, wider dashboard. A future iteration may add a
2–3 line summary line to `audit` (total reused / questioned / top-questioned
count) — no per-atom detail.

## Correctness

- **Atomicity:** sidecar writes use temp-file + `rename`. The gateway daemon is
  a single process; telemetry writes are serialized in-process.
- **Back-compat:** missing sidecar → all counters treated as 0; new
  `turn.processed` fields are optional (legacy events read unchanged); atom `.md`
  files untouched (BM25 mtime index never invalidated by telemetry).
- **Failure isolation:** a telemetry write failure must never break a turn or a
  reaction — wrap in try/catch, log, continue.
- **Only approved atoms** are retrieved, so telemetry naturally tracks the
  approved corpus.

## Testing

- Reuse bump: increments + `lastRetrievedAt` set; **not** bumped when the LLM
  call fails (bump site is post-success).
- Questioned — 👎: negative emoji on a cited reply bumps the right atomIds;
  reaction on an approval anchor still does approve/reject only; non-negative
  emoji is a no-op.
- Questioned — escalate: bumps the most-recent prior same-thread turn's atoms;
  does **not** match a later reply or a different thread/channel.
- Dedupe: repeated reaction / retry / remove+re-add bumps once;
  escalate dedupe by source turn.
- Back-compat: no sidecar → zeros; legacy `turn.processed` without new fields.
- `atoms telemetry`: sort order (dead-weight / load-bearing), `--json` parses.

## File map

| Path | Change |
|---|---|
| `packages/cli/src/gateway/atom-telemetry.ts` (new) | sidecar read/write + bump helpers + dedupe |
| `packages/cli/src/gateway/events.ts` | extend `TurnProcessedEvent` (4 optional fields) |
| `packages/cli/src/gateway/slack/free-chat-turn.ts` | reuse bump + populate extended event at success site |
| `packages/cli/src/gateway/slack/index.ts` | `handleReactionAdded` citation-feedback branch |
| `packages/cli/src/gateway/slack/escalation.ts` (or escalate emit site) | escalate-after-citation questioned bump |
| `packages/cli/src/commands/gateway.ts` | `atoms telemetry` subcommand dispatch + render |
| `packages/cli/test/gateway-atom-telemetry.test.ts` (new) | all cases above |

## Deferred (P2b / future)

- Approver rubric ADR + quarterly audit playbook (needs real traffic).
- `questionedKeys` pruning / sidecar compaction.
- Telemetry as a retrieval-ranking input.
- 2–3 line telemetry summary inside `gateway audit`.
