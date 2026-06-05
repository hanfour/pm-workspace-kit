---
sidebar_position: 5
---

# Atom audit playbook (quarterly)

A recurring, telemetry-driven review of the **existing** approved atoms, to keep the PKB high-signal as it grows. It is the safety net to [ADR-0007](../adr/0007-atom-approval-rubric.md)'s approval gate: the rubric prevents low-signal atoms at the door; this audit catches what slipped through (notably via TTL auto-promote) and retires what has gone stale.

## When + who

- **Cadence:** quarterly.
- **Who:** the gateway host / atom approver.
- **Input:** `pmk gateway atoms telemetry` — joins the approved corpus with the per-atom telemetry sidecar (`reuseCount`, `lastRetrievedAt`, `questionedCount`, `lastQuestionedAt`) and flags dead-weight / load-bearing.

## The four review flags

These are **review flags, not a partition** — an atom can trip more than one, and most healthy atoms (recent, low-but-nonzero reuse, no questions) trip none. Apply this **precedence** for the headline action (first match wins) and count the rest:

**Questioned → Dead-weight → Stale → Load-bearing → Unflagged (keep).**

| Flag | Signal | Action |
|---|---|---|
| **Questioned** | `questionedCount` meets the threshold (below) | review the atom + its source → fix (re-ground/edit) or retire. Highest precedence: a grounding problem outranks low usage. |
| **Dead-weight** | `reuseCount` is 0 after the maturity window | retire candidate — remove unless there is a known reason to keep. |
| **Stale** | `lastRetrievedAt` is old + reuse is low | review for relevance → keep / edit / retire. |
| **Load-bearing** | high `reuseCount`, `questionedCount` 0 | keep; the corpus backbone — do not churn. |
| **Unflagged** | none of the above | keep, no action; counted in the run total. |

## Thresholds (v0 — calibrate against real data)

Conservative starting values, **not** data-derived. The first audit with real organic telemetry should re-check and adjust them.

- **Dead-weight maturity window:** ⚖️ calibrate: one quarter (~90 days). Long enough that a genuinely useful atom would have been retrieved at least once across a quarter's traffic.
- **Questioned threshold:** ⚖️ calibrate: `questionedCount ≥ 2` **or** (`reuseCount ≥ 5` **and** `questionedCount / reuseCount ≥ 0.3`). A single 👎 is noise, so the ratio arm needs a reuse floor; the `5` mirrors the CLI's `LOAD_BEARING_MIN_REUSE` — treat the CLI's actual value as source of truth if it ever changes.
- **Stale window:** ⚖️ calibrate: `lastRetrievedAt` older than two quarters with low reuse. Half a year unused is a strong relevance signal.

## Steps

1. Run `pmk gateway atoms telemetry` (add `--json` to script the triage).
2. For each atom, apply the precedence above to get one headline flag + action.
3. Action the flags: retire dead-weight (and confirmed-bad questioned) atoms; fix (re-ground/edit) recoverable questioned atoms; leave load-bearing + unflagged alone.
4. **Recalibrate:** check whether the v0 thresholds above match what you observed; adjust and note the change.
5. **Record an audit-log entry** (below).

## Audit log

Keep a short entry per run so successive audits show the trend:

```
## <YYYY-Qn> atom audit (<date>)
- total atoms: <N>   (unflagged kept: <N>)
- questioned: <N> → fixed <N>, retired <N>
- dead-weight: <N> → retired <N>
- stale: <N> → kept <N>, edited <N>, retired <N>
- load-bearing: <N>
- threshold changes: <none | describe>
```

## Related

- [ADR-0007: Atom approval rubric](../adr/0007-atom-approval-rubric.md) — the prevention side.
- Atom telemetry (P2a): `pmk gateway atoms telemetry`.
- priorities-plan P2 — `apps/docs/docs/plans/2026-05-product-priorities-plan.md`.
