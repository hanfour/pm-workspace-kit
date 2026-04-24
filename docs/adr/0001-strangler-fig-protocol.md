---
sidebar_position: 2
---

# ADR-0001: Strangler Fig Migration Protocol

- **Status:** Accepted
- **Date:** 2026-04-24
- **Deciders:** Architect, PM Lead, Engineering Lead
- **Tags:** migration, methodology

## Context

Any migration of a large monolith to a new system takes multiple quarters. Teams that improvise the protocol end up with:

- Inconsistent reconciliation standards across modules
- No clear rollback path when things break
- "How long is Stage 2?" answered differently per module
- Stakeholder surprise ("I thought we shipped this already?")

A shared protocol with named stages and quantitative exit criteria solves all four.

## Decision

Adopt the four-stage **Strangler Fig** protocol (see [Concepts: Strangler Fig](../concepts/strangler-fig.md) for narrative). Every module migration uses the same stage names, reconciliation thresholds, and rollback playbooks. Per-module overrides require an explicit note in the module's playbook.

### The four stages

1. **Stage 0 — Prep**: schema + service + reconciliation tool ready in new system; no traffic yet. Feature flag `migration.<module>.mode = off`.
2. **Stage 1 — Shadow Read**: read traffic served from old; new system queried in parallel; diffs logged. Exit: < 0.1% diff rate × 7 days.
3. **Stage 2 — Double Write**: writes go to both systems; hourly reconciliation. Exit: < 0.01% diff × 14 days.
4. **Stage 3 — Cutover**: traffic to new, old stays hot via reverse-sync, rollback in < 5 min. Exit: KPIs steady × 14 days.
5. **Stage 4 — Retire**: old code frozen, tables read-only, 30-day observation (financial: through one monthly close; tax-regulated: 7-year retention).

### Module overrides

Per-module playbook may override defaults:
- **Financial / regulated**: tighten reconciliation tolerance 10× (< 0.001%); mandatory HITL on all writes; Stage 4 waits a full cycle.
- **High-volume, low-criticality**: Stage 1 may shorten to 3 days if diff is zero; Stage 2 skippable if upstream is idempotent.

## Consequences

### Positive
- Same vocabulary across modules; on-call and review are reusable.
- Rollback is rehearsed per stage, not improvised during incidents.
- Stakeholders can see migration progress in stage % terms.
- Reconciliation job is a reusable pattern, not per-module invention.

### Negative
- Dual-write window costs 10–20% throughput on writes.
- Per-module infrastructure cost increases ~30–50% during migration.
- Stage-3 reverse-sync complexity is real; implementation takes planning.

### Neutral
- Some modules will finish in 6 weeks, others in 16. That's fine.
- Legacy code can't be deleted on a predictable calendar — retire depends on business cycle.

## Alternatives Considered

### Alternative A: Shadow read → single big-bang cutover
- **Pros**: simpler; no dual-write complexity.
- **Cons**: write path unvalidated until cutover; cutover risk high for transactional modules.
- **Rejected**: financial modules with heavy write load can't accept cutover risk.

### Alternative B: Database-level CDC (e.g. Debezium)
- **Pros**: application doesn't change.
- **Cons**: only data-level; can't validate business-rule correctness on new side.
- **Rejected**: the point of the migration is to improve business logic layer too; CDC alone doesn't cover it.

### Alternative C: No protocol — team-by-team improvisation
- **Pros**: maximum flexibility.
- **Cons**: first failure mode that triggered this ADR.
- **Rejected.**

## References

- Martin Fowler, ["StranglerFigApplication"](https://martinfowler.com/bliki/StranglerFigApplication.html)
- [Concepts: Strangler Fig](../concepts/strangler-fig.md)
- [Templates: Module Playbook](../templates/module-playbook-template.md)
