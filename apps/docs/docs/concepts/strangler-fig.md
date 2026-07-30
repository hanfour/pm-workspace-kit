---
sidebar_position: 4
---

# Strangler Fig Protocol

For migrating a large monolith to a new system without a big-bang rewrite. Four named stages, each with a quantitative exit criterion. This kit's pre-written **ADR-0001 Strangler Fig Protocol** is the canonical reference; this page is the concept overview.

## The four stages

```mermaid
flowchart LR
  P[Stage 0<br/>Prep]
  R[Stage 1<br/>Shadow Read]
  W[Stage 2<br/>Double Write]
  C[Stage 3<br/>Cutover]
  T[Stage 4<br/>Retire]

  P --> R --> W --> C --> T

  R -.diff < 0.1%, 7d.-> W
  W -.recon diff < 0.01%, 14d.-> C
  C -.KPIs steady, 14d.-> T
```

### Stage 0 — Prep (1–2 weeks)

The new code path exists and can serve a CRUD call correctly in isolation. No traffic is touching it yet.

**Exits when:**
- Schema + migration ready in the new system
- Domain model + basic service layer pass unit tests
- Reconciliation tooling (`scripts/reconcile-*.ts` pattern) is runnable locally
- Feature flag `migration.<module>.mode` exists, defaults to `off`

### Stage 1 — Shadow Read (≥7 days)

Read traffic is still served from the old system. The bridge forwards the same query to the new system _in parallel_ and logs discrepancies. The user sees nothing new.

**Exits when:**
- Diff rate below 0.1% for 7 consecutive days
- No P1 incidents attributable to the new code path

### Stage 2 — Double Write (≥14 days)

Writes go to both systems. A reconciliation job compares row-level data and derived aggregates hourly. Divergences land in a `reconciliation_diffs` table and auto-alert above threshold.

**Exits when:**
- Reconciliation diff rate below 0.01% for 14 days
- Pacing KPIs, derived values, and aggregate totals all match
- At least one monthly or quarterly cycle has completed without manual intervention (for financial modules)

### Stage 3 — Cutover (≥14 days)

Traffic moves to the new system. The old system stays hot — write via reverse-sync from new → old, read hits new. A single feature-flag flip brings the old system back if needed (target: under 5 minutes).

**Exits when:**
- User-facing KPIs (error rate, p95 latency, functional completeness) don't degrade vs baseline for 14 days
- Rollback drill has been rehearsed
- On-call handover complete

### Stage 4 — Retire (1–4 weeks or longer)

Old code paths are frozen (PRs refused), data tables become read-only archives. A 30-day waiting period for financial / regulated modules before any deletion. Keep tables for 7 years if tax law applies.

## Per-module overrides

The default thresholds above work for most modules. Two kinds of module override the defaults:

**Financial / regulated**:
- Reconciliation tolerance 10× tighter (0.001% instead of 0.01%)
- Mandatory one-cycle observation (monthly close) before Stage 3 → Stage 4
- All writes require Human-in-the-Loop (HITL) regardless of amount

**High-volume, low-criticality** (e.g. analytics ingestion):
- Stage 1 can shorten to 3 days if diff rate is zero from day one
- Stage 2 may skip if the upstream is idempotent and reversible

Document overrides in the module's playbook (`docs/architecture/modules/<module>-migration.md`), not the protocol ADR.

## Module dependency matrix

Stage 3 cutover creates cross-module consistency risk. If module A writes to module B (e.g. campaigns create accounts-receivable rows), they must cut over together _or_ have an API contract that tolerates one side being on either version.

The kit's module playbook template includes a R/W dependency matrix. Fill it in during Stage 0 and let it drive the cutover sequence.

## Rollback, not rollback-in-theory

Every stage transition has a rollback procedure. Every one gets rehearsed at least once before the real thing.

- **Stage 2 → 1**: stop double-writing, clean reconciliation queue. ~1 hour.
- **Stage 3 → 2**: flip feature flag, accept that writes during the cutover window are in the new system only and need reverse-sync. Target: 5 minutes.
- **Stage 4 → 3**: worst case. Old code is deleted. Recover from Git, redeploy. This is why the 30-day observation matters.

## When the protocol doesn't fit

- **Green-field features**: no old system to strangle. Use a standard deploy.
- **Non-data-shaped migrations** (e.g. infra re-architecture with no persistent state shift): adapt the stages but skip reconciliation.
- **Sub-week migrations**: the protocol is overhead. Flip it as a single-stage feature flag and monitor.

The protocol earns its keep when the migration is both long (multi-week) and stateful (data consistency is the risk). Otherwise simpler is better.

## Related

- ADR-0001 (methodology) — this kit's pre-written protocol ADR, in `docs/adr/`
- [Templates: Module Playbook](../templates/module-playbook-template)
- [Guide: Handoff to Implementation](../guides/handoff-to-implementation)
