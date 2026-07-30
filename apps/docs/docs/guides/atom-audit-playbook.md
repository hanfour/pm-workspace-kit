---
sidebar_position: 5
---

# Atom audit playbook (quarterly)

A recurring, telemetry-driven review of the **existing** approved atoms, to keep the PKB high-signal as it grows. It is the safety net to [ADR-0007](../adr/atom-approval-rubric)'s approval gate: the rubric prevents low-signal atoms at the door; this audit catches what slipped through (notably via TTL auto-promote) and retires what has gone stale.

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

## Thresholds (v0 — retained after the first audit; see Audit history)

Conservative starting values, **not** data-derived. The 2026-Q3 first audit ran
against real organic telemetry but found the corpus too small (n=2) to derive
better values — v0 is retained deliberately rather than tuned on noise.
Re-calibrate when the corpus reaches ~15–20 atoms or at the next quarterly
audit, whichever comes first.

- **Dead-weight maturity window:** ⚖️ calibrate: one quarter (~90 days). Long enough that a genuinely useful atom would have been retrieved at least once across a quarter's traffic. _(2026-Q3: zero atoms with `reuseCount 0` — no signal either way.)_
- **Questioned threshold:** ⚖️ calibrate: `questionedCount ≥ 2` **or** (`reuseCount ≥ 5` **and** `questionedCount / reuseCount ≥ 0.3`). A single 👎 is noise, so the ratio arm needs a reuse floor; the `5` mirrors the CLI's `LOAD_BEARING_MIN_REUSE` — treat the CLI's actual value as source of truth if it ever changes. _(2026-Q3: zero questioned events in the whole history — no signal.)_
- **Stale window:** ⚖️ calibrate: `lastRetrievedAt` older than two quarters with low reuse. Half a year unused is a strong relevance signal. _(2026-Q3: both atoms retrieved within the last day — no signal.)_

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

## Audit history

### 2026-Q3 atom audit (2026-07-17) — first run

- total atoms: 2   (unflagged kept: 1)
- questioned: 0 → fixed 0, retired 0
- dead-weight: 0 → retired 0
- stale: 0 → kept 0, edited 0, retired 0
- load-bearing: 1 (`2026-04-28T0213-5388` 部門廣告預算, erp — reuse **35** over 79 days, 0 questioned, last retrieved the day before the audit)
- threshold changes: **none — v0 retained.** n=2 is too small to derive better values; tuning on this would be fitting noise. All three thresholds had zero triggering signal (no zero-reuse atoms, no questioned events, nothing near the stale window).
- provenance sanity-check: **organic ✓** — both atoms carry real thread keys + contributor; the AcmeAds demo scope is empty (unseeded 2026-06-05).
- observations for next audit:
  - **The corpus grew far slower than P2 anticipated** (2 atoms in ~2.5 months). The audit's real finding is that absorb-rate, not corpus quality, is the current bottleneck — the loop works (the load-bearing atom proves reuse compounds), but few answers are being absorbed.
  - P2a telemetry instrumentation held up across 79 days of live traffic (reuse counter, lastRetrievedAt, load-bearing flag all consistent with the events log).
  - Next audit: 2026-Q4, or earlier if the corpus reaches ~15–20 atoms.

## Related

- [ADR-0007: Atom approval rubric](../adr/atom-approval-rubric) — the prevention side.
- Atom telemetry (P2a): `pmk gateway atoms telemetry`.
- priorities-plan P2 — `apps/docs/docs/plans/2026-05-product-priorities-plan.md`.
