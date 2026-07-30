---
doc_id: ADR-2026-0007
title: Atom approval rubric — strict five-axis gate at proposal time
owner: "@hanfour"
status: Accepted
date: 2026-06-05
related:
  prd: []
  module:
    - packages.cli
  confluence_page_id: null
---

# ADR-0007: Atom approval rubric — strict five-axis gate at proposal time

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** @hanfour
- **Tags:** gateway, knowledge, pkb, process

## Context

The gateway proposes knowledge atoms from conversations; a human approver reacts (👍 approve / edit-then-approve / 👎 reject), with a TTL auto-promote fallback for un-acted proposals. As the PKB grows, accumulating low-signal atoms is an effectively irreversible failure mode — the later you clean, the more there is (priorities-plan brief R4). v0.17.0 (P2a) added per-atom telemetry (`reuseCount`, `lastRetrievedAt`, `questionedCount`, `lastQuestionedAt`), but telemetry only describes an atom *after* it has been retrieved — it cannot inform the *initial* approval. So the primary quality gate must sit at approval time, applied consistently. This ADR documents that rubric. The recurring telemetry-driven cleanup of existing atoms lives in the separate [atom audit playbook](../guides/atom-audit-playbook).

## Decision

Approve a proposed atom only when it clears **all five** content-quality axes; otherwise absorb-with-edit or reject. The default disposition is **strict** — low-signal atoms do not enter the corpus on the assumption the audit will clean them later.

The five axes (the approver asks each):

1. **Grounded** — traceable to a verifiable source: a doc / code / ADR / PRD / named system or field, **or a named SME's answer in the captured source thread**. A distilled answer from a named IT/domain expert is grounded — only genuinely unsourced claims fail.
2. **Durable** — a stable fact likely to be asked again, not a one-off / time-bound / ephemeral answer.
3. **Correctly scoped** — right scope tag, filed where that scope's audience would look.
4. **Non-duplicate** — not already covered by an approved atom; overlapping content is merged, not duplicated.
5. **Self-contained** — answerable on its own, with no dangling "depends on the thread above" context.

Outcome mapping:

- **Approve (👍):** clears all five.
- **Absorb-with-edit:** good core but fails one of the *fixable* axes — **correctly-scoped / non-duplicate / self-contained** → edit (re-scope, merge, or tighten), then approve.
- **Reject (👎):** fails **grounded** or **durable** (the axes an edit can't fix), or is a pure duplicate adding nothing new.

**TTL auto-promote stance:** keep auto-promote as a fallback for un-acted proposals; the quarterly audit catches whatever it promotes without the rubric. High-stakes scopes could later lengthen or disable the auto-promote TTL — a future tuning lever, not decided here.

## Consequences

### Positive
- The corpus stays high-signal: low-signal atoms are stopped at the door, not after they've diluted retrieval.
- A consistent, teachable checklist makes approver decisions repeatable across people and time.
- Pairs with the audit playbook: the rubric prevents; the audit cleans up auto-promote leakage.

### Negative
- A strict gate rejects some borderline-useful atoms; genuine knowledge can be lost to an over-zealous approver (mitigated: the source thread stays searchable and the atom can be re-proposed).
- More approver effort per proposal than a lenient "approve unless obviously bad" stance.
- The rubric is human-applied, not enforced in code — consistency depends on the approver following it.

### Neutral
- Auto-promote remains a leak path by design; the audit absorbs that. Tightening it is deferred.

## Alternatives Considered

### Alternative A: Lenient approval + rely on the quarterly audit to clean dead weight
- **Pros:** less approver effort; leans on the P2a telemetry already built.
- **Cons:** low-signal atoms exist and dilute retrieval for up to a quarter before cleanup; the irreversible-accumulation failure mode is exactly what brief R4 warns against.
- **Rejected because:** the failure mode's cost grows with delay — preventing is cheaper than periodically cleaning.

### Alternative B: Tiered strictness by scope/source
- **Pros:** could relax the gate for low-risk auto-extracted atoms.
- **Cons:** more rubric complexity; harder to apply consistently.
- **Rejected because:** YAGNI for now — a single strict rubric is simpler; revisit if a scope clearly warrants different handling.

## References

- priorities-plan P2 — `apps/docs/docs/plans/2026-05-product-priorities-plan.md`
- [Atom audit playbook](../guides/atom-audit-playbook) — the cleanup side of P2
- Atom telemetry (P2a, v0.17.0): `packages/cli/src/gateway/atom-telemetry.ts`, `pmk gateway atoms telemetry`
