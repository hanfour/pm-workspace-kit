---
slug: /intro
sidebar_position: 1
---

# Introduction

**PM Workspace Kit** is an opinionated template for the kind of work that happens _before_ production code: product discovery, migration planning, cross-team reviews, and keeping all of it traceable after the initial excitement wears off.

It was extracted from a real 18-month ERP migration planning effort. The domain content (product entities, module playbooks, specific SLOs) was stripped out. What's left is the structural scaffolding that worked — and the scripts that enforce it in CI so it doesn't rot.

## What you get

### Scripts that enforce discipline

- **`traceability.js`** — scans markdown front-matter, validates required fields, emits a Mermaid dependency graph + reverse-lookup + orphan report.
- **`confluence-sync.js`** — pulls comments and status labels from Confluence back into your Git-of-record so reviewer activity doesn't evaporate in a wiki.

### Templates that end arguments

- **ADR template** (MADR-style) with slots for Alternatives Considered and Consequences (positive / negative / neutral).
- **Module migration playbook** — 12 sections including Stage 0–4 Strangler Fig checklist and quantitative exit criteria.
- **North-star architecture outline** — 10-chapter scaffold (Exec Summary → As-Is → Vision → To-Be → Three Pillars → Roadmap → Migration → Cross-cutting → ADR Index → Appendix).
- **PR / Code review / Runbook / Dashboard / Readiness** — five handoff documents so engineering inherits a plan, not prose.

### Methodology ADRs (pre-written)

- **Strangler Fig Protocol** — four named stages with exit thresholds and rollback playbooks.
- **Dev Harness convention** — how to layer Claude Code skills / hooks / subagents across a monorepo.
- **Product Decision Log** — a dedicated ADR class for product-facing decisions (pricing, entitlement, MVP scope) so they stop getting re-litigated.

## What you don't get

- **A project management tool.** Tickets still live in Linear / Jira / whatever.
- **A wiki replacement.** This kit works _with_ Confluence; it doesn't try to replace it.
- **Auto-generated architecture.** Humans still decide, ADRs still get written, migrations still get planned — the kit just gives those acts a shared shape.

## Who it's for

- **PMs and systems analysts** in companies that have outgrown free-form Notion docs.
- **Engineering leads** about to plan a platform migration and dreading the 50-page design doc.
- **Staff+ engineers** who want a lightweight ADR + Strangler Fig toolkit they can drop into any repo.

## Next

- [Getting Started](./getting-started.md) — 10 minutes from clone to first PRD with validated front-matter.
- [Concepts: Traceability](./concepts/traceability.md) — the front-matter schema and why it matters.
- [Example: AcmeAds](./examples/acme-ads.md) — a fictional ad-tech company using the kit end-to-end.
