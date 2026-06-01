# Adoption metrics — design (P4)

**Date:** 2026-06-01
**Status:** Approved (design); implementation pending
**Source:** priorities-plan P4 — 採用成功的計量 ([`apps/docs/docs/plans/2026-05-product-priorities-plan.md`](../../../apps/docs/docs/plans/2026-05-product-priorities-plan.md))

## Context

P4 answers "is anyone actually using this?" with numbers instead of feelings. It
was gated on P2 (atom telemetry), which shipped in v0.17.0 — so the data now
exists. An inventory of the five plan metrics shows **four already have their raw
data** (the gateway event log + `gateway audit` aggregates + the new telemetry
sidecar); only **time-to-first-PRD** needs new instrumentation (it is a CLI /
`pmk propose` concern, not a gateway one).

So P4 is mostly **computing adoption rates from existing data + one new marker**,
surfaced as a single cohesive rollup.

## Goals

- One command answers "is this being adopted?" across both surfaces (CLI + gateway).
- Reframe existing raw counts as adoption **rates** (self-answer, conversion, reuse).
- Add the one missing signal: time-to-first-PRD.

## Non-goals

- **No replacement of `gateway audit`.** Audit stays the operational-health
  deep-dive (per-user split, durations, context safety, token usage). Adoption is
  a separate "is anyone using this" lens — it reuses audit's aggregation, doesn't
  fold into it.
- **No new gateway-side instrumentation.** Metrics 2–5 are pure computation over
  data that already exists.
- **No cross-host aggregation.** Host-run model → metrics are per host/install.

## Surface & data flow

New **top-level** command `pmk adoption [--days N] [--json]` (default N=7).
Top-level (not under `gateway`) because adoption spans the CLI (time-to-first-PRD)
and the gateway (turns / mra-ask / escalate / reuse).

The command does I/O; a **pure** builder does the computation (testable without
disk):

- `buildAuditReport({ days: N, nowMs })` — reuses the existing gateway event
  aggregation (turns, mra-ask, escalate). (Signature is
  `{ days?, nowMs? }` per `packages/cli/src/gateway/audit.ts`; pass `nowMs` so
  the window is deterministic in tests.)
- `loadTelemetry()` + `loadAtoms({ promote: false })` — atom reuse.
- `readMarkers()` from `~/.pmk/adoption.json` — time-to-first-PRD.
- → `buildAdoptionReport(auditReport, telemetry, atoms, markers, now, windowDays)`
  → `AdoptionReport`.

## The five metrics

Each metric is labeled by its time scope so a reader isn't misled.

| # | Metric | Definition | Scope |
|---|---|---|---|
| 1 | Time-to-first-PRD | `firstPrdAt − firstRunAt` (→ `n/a (existing install)` when `preExisting`; `no PRD yet` when `firstPrdAt` null; `unknown` when `firstRunAt` null) | one-time |
| 2 | Answered questions | `auditReport.conversations.totalTurns` over N days (+ normalized /week) | window (N days) |
| 3 | Self-answer rate | `(totalTurns − escalate.triggered) / totalTurns` — bot handled it without escalating to a human; mra-ask `successes / invocations` shown as a secondary number | window |
| 4 | Escalation→**saved-atom** conversion | `savedAtomEscalations / triggeredEscalations`, where `savedAtomEscalations = auditReport.escalate.absorbed` and `triggeredEscalations = auditReport.escalate.triggered` | window |
| 5 | Atom reuse rate | `(# approved atoms with telemetry reuseCount > 0) / (# approved atoms)` (+ total reuse count) | cumulative |

**Metric 3 framing (decided):** the plan's "mra-ask success rate (LLM
self-answer vs escalation)" is implemented as the **self-answer rate** above —
the share of questions the bot handled without escalating to a human — because
that is the most direct answer to "is it helping?". The narrower mra-ask
`successes / invocations` (denominator = only turns that invoked mra-ask) is
shown alongside as a secondary figure, not the headline.

**Metric 4 semantics:** `escalate.absorbed` is emitted **only after an atom is
actually saved** (`packages/cli/src/gateway/slack/escalation.ts` returns early
when the extractor produces no atom, *before* the emit, so every
`escalate.absorbed` carries an `atomId`). The metric is therefore
escalation-to-**saved-atom** conversion — a human reply that produced no usable
atom does **not** count. The renderer should label it "escalation → saved atom"
so it isn't read as "IT replied" or "absorb attempted".

## New instrumentation — run markers

New module `src/run-markers.ts`. A single file `~/.pmk/adoption.json`:

```jsonc
{
  "firstRunAt": "2026-06-01T...Z",
  "firstPrdAt": "2026-06-01T...Z" | null,
  // True when firstRunAt was set on an install that already had pmk state
  // (so firstRunAt is NOT a true adoption start — see below).
  "preExisting": false
}
```

- `recordFirstRun(at?)` — set `firstRunAt` only if currently absent
  (**write-if-absent**, never overwrite). On that first write, also set
  `preExisting`: true when `~/.pmk` already holds prior pmk state (any of
  `~/.pmk/gateway.json`, `~/.pmk/knowledge/`, or a gateway events log exists) —
  i.e. the marker was added to an install that was already in use, so
  `firstRunAt` records "first run after upgrade", not first-ever adoption.
  Called at the CLI entry point.
- `recordFirstPrd(at?)` — set `firstPrdAt` only if absent. Called after
  `pmk propose` **successfully writes a PRD**.
- `readMarkers()` → `{ firstRunAt: string | null, firstPrdAt: string | null, preExisting: boolean }` (`preExisting` defaults to `false` when the file or field is absent).

Writes are **synchronous**, **failure-isolated** (a marker write must never break
a CLI invocation or a propose run — wrap in try/catch), and use temp-file +
rename. Default `at` to now-ISO; tests pass an explicit `at`.

**Back-compat / honesty:** a host that installed before this ships has no
`firstRunAt`. On the first `pmk` run after upgrade, `recordFirstRun` sets it —
but also detects the pre-existing state and sets `preExisting: true`. The
renderer then shows metric 1 as **`n/a (instrumentation added to an existing
install)`** instead of a misleading "time from first post-upgrade command to
first PRD". A genuinely fresh install (`~/.pmk` empty at first run) gets
`preExisting: false` and a real measurement. This is the difference between
"first-ever adoption" and "first run after upgrade" the metric must not blur.

## Instrumentation points

- `src/index.ts` (CLI entry) — call `recordFirstRun()` once near the top, before
  command dispatch. Failure-isolated.
- `src/commands/propose.ts` — call `recordFirstPrd()` only on the success path,
  after the PRD file is written (never on failure/abort).

## File map

| Path | Change |
|---|---|
| `packages/cli/src/run-markers.ts` (new) | adoption.json markers: `recordFirstRun` / `recordFirstPrd` / `readMarkers` (sync, write-if-absent, failure-isolated, temp+rename) |
| `packages/cli/src/adoption.ts` (new) | pure `buildAdoptionReport(...)` + `AdoptionReport` type |
| `packages/cli/src/commands/adoption.ts` (new) | `pmk adoption [--days N] [--json]` — reads sources, renders text + json |
| `packages/cli/src/index.ts` | `recordFirstRun()` at entry + dispatch `adoption` |
| `packages/cli/src/commands/propose.ts` | `recordFirstPrd()` on success |
| `packages/cli/test/adoption.test.ts` (new) | builder + markers + command |

## Correctness / edge cases

- **Division by zero / empty:** `totalTurns === 0` → self-answer rate `n/a`;
  `escalate.triggered === 0` → conversion `n/a (no escalations)`;
  `approvedAtoms === 0` → reuse rate `n/a`.
- **Markers absent / partial:** `firstRunAt` null → metric 1
  `unknown (pre-instrumentation)`; `firstPrdAt` null → `no PRD yet`;
  `preExisting === true` → `n/a (instrumentation added to an existing install)`
  (takes precedence — don't show a duration for an install whose `firstRunAt`
  isn't a true adoption start).
- **Purity:** `buildAdoptionReport` performs no I/O and calls no `Date.now()` —
  `now` and markers are passed in, so the builder is deterministic and testable.
- **Failure isolation:** marker writes are best-effort; never throw into the CLI.
- **Reuse rate is cumulative**, not windowed (telemetry counters are lifetime);
  the report labels it so it isn't read as a 7-day figure.

## Rendering

- **Text:** a short report headed by the question it answers ("is this being
  adopted?"), one line per metric with its value and scope label, plus the
  secondary mra-ask figure under metric 3. Plain and skimmable.
- **`--json`:** the full `AdoptionReport` object (for scripts, the P5 demo
  bundle, and the existing P2b check-back routine).

## Testing

- `buildAdoptionReport`: each metric computed from a synthetic
  audit-report/telemetry/atoms/markers fixture; div-by-zero / empty → `n/a`;
  scope labels present; one-time vs window vs cumulative not conflated; metric 1
  → `n/a (existing install)` when `preExisting`, `no PRD yet` when `firstPrdAt`
  null, real duration when both present and `!preExisting`.
- `run-markers`: `recordFirstRun` writes once and is idempotent (a second call
  does not overwrite an existing `firstRunAt`); sets `preExisting: true` when
  `~/.pmk` already has prior state (e.g. a `gateway.json` present) and `false`
  on an empty `~/.pmk`; same write-once for `recordFirstPrd`; `readMarkers`
  returns nulls + `preExisting:false` when the file is absent; failure-isolated
  (a bad path does not throw).
- `propose` records `firstPrdAt` on success and **not** on a failed run.
- `adoption` command: text render + `--json` parses to the expected shape.

## Out of scope / future

- Cross-host / fleet aggregation (host-run model is single-host).
- Trend over time (the check-back routine and `--json` snapshots can build that
  later; not part of this command).
- Surfacing adoption inside `gateway audit` (kept separate by design).
