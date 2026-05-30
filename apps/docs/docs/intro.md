---
slug: /intro
sidebar_position: 1
---

# Introduction

**PM Workspace Kit** is an opinionated template for the kind of work that happens _before_ production code: product discovery, migration planning, cross-team reviews, and keeping all of it traceable after the initial excitement wears off.

It was extracted from a real 18-month ERP migration planning effort. The domain content (product entities, module playbooks, specific SLOs) was stripped out. What's left is the structural scaffolding that worked — the scripts that enforce it in CI so it doesn't rot, plus a CLI (`pmk`) and a Slack gateway that turn each PM verb into a repeatable conversation against your real codebase.

## The product, one line

PMK turns PM documents, code intelligence, and human expert answers into a **traceable knowledge loop** for code-aware teams.

## Three product surfaces

The kit has three surfaces. The first two carry the main value today; the third is an early shell that the project will return to once the gateway loop is mature.

### 1. Local doc/code workflow — `pmk` CLI + templates + traceability

The day-to-day workhorse. PM verbs as named conversations (`pmk propose`, `pmk ask`, `pmk case`, …), backed by:

- **`traceability.js`** — markdown front-matter validation, Mermaid dependency graph, reverse-lookup, orphan report. Runs in CI so links don't rot.
- **`confluence-sync.js`** — pulls reviewer comments and status labels back from Confluence so wiki activity doesn't evaporate.
- **ADR template** (MADR-style) with slots for Alternatives Considered and Consequences.
- **Module migration playbook** with a Stage 0–4 Strangler Fig checklist and quantitative exit criteria.
- **Handoff kit** — PR / Code review / Runbook / Dashboard / Readiness, so engineering inherits a plan, not prose.

### 2. Slack gateway — knowledge loop for non-CLI stakeholders

The differentiated surface. Stakeholders who won't install a CLI can DM or `@`-mention a bot in the Slack workspace they already use; one host runs the bridge against their machine and pays the LLM bill.

The loop: **retrieval over your PKB → automatic `mra-ask` when retrieval isn't enough → escalation to a human IT contact → absorb the answer into a `KnowledgeAtom` → approval gate → future questions hit the cached answer**.

This loop is what makes PMK more than a PRD generator or a wiki bot.

### 3. Desktop app — early shell (secondary)

Electron GUI over the same CLI surface (chat panel + worktree manager). Still early; treat as a secondary surface until parity with the [Desktop PRD](./prds/2026-04-24-desktop-app-prd.md) is reached. The CLI and gateway carry the core experience today.

## Base value vs. mra-enhanced value

PMK does two distinct things depending on whether [`multi-repo-agent`](https://github.com/hanfour/multi-repo-agent) (mra) is installed. Both are real; just be clear which one you're getting.

| Feature | Without mra | With mra |
|---|---|---|
| `pmk propose` / `ask` / `case` | RAG over your `docs/` only | Same + grounded in real module / endpoint names from your repos |
| `traceability.js` / Confluence sync | Full functionality | Full functionality |
| Slack gateway PKB retrieval | Works on your existing markdown | Same, plus auto-loaded `mra:--all` summaries on first turn |
| Gateway `mra-ask` escalation | No-op | Bot can answer code-level questions before tagging a human |
| Knowledge atom absorb / retrieval | Works | Works |

In short: **base value = traceable PM docs + Slack Q&A grounded in markdown**. **mra-enhanced value = the above + code-aware answers**. Both surface in the same CLI / gateway; the difference is what the model can ground in.

## 30-day adoption path

The fastest way to feel the value is to follow this order. The earliest steps don't need mra; mra-enhanced value comes online in Week 2.

- **Day 1** — `pmk propose` produces a real PRD in `docs/prds/`. Same-day output, no infra needed.
- **Day 2–3** — Author a second PRD. `traceability.js` now has links to validate; the dependency graph and orphan report start earning their keep.
- **Week 1** — Stand up the Slack gateway against one channel. Today's flow lives in the [gateway lifecycle](./gateway/lifecycle.md) deep-dive, with a 30-minute walkthrough in the [onboarding guide](./gateway/onboarding.md); `pmk gateway doctor` + `gateway start --dry-run` make the first install verifiable before live traffic. Seed your existing PKB.
- **Week 2** — Run the full knowledge loop end-to-end: ask → `mra-ask` → escalation → absorb → reuse. By this point, the second PM who asks a previously-escalated question gets the cached answer without anyone re-typing.

## What you don't get

- **A project management tool.** Tickets still live in Linear / Jira / whatever.
- **A wiki replacement.** This kit works _with_ Confluence; it doesn't try to replace it.
- **Auto-generated architecture.** Humans still decide, ADRs still get written, migrations still get planned — the kit just gives those acts a shared shape.
- **A hosted SaaS.** The CLI and gateway run on your machine against your repos. Nothing leaves the host.
- **High-precision vector knowledge search.** Retrieval is intentionally BM25 over markdown — local, cheap, explainable. If you need semantic search at corpus scale, this isn't that product.

## Who it's for

- **Engineer-PMs / SAs / staff engineers** already living in Git, ADRs, and migration plans.
- **Teams planning or executing a platform migration** — traceability + Strangler Fig + handoff templates pay off fastest here.
- **Non-engineer stakeholders** — _not_ as CLI users, but as participants in the Slack gateway loop.
- **Small or internal-tooling teams** that accept a host-run, local-first, non-SaaS deployment model.

## Next

- [Getting Started](./getting-started.md) — 10 minutes from clone to first PRD with validated front-matter (plus a CLI quickstart).
- [Concepts: Traceability](./concepts/traceability.md) — the front-matter schema and why it matters.
- [Gateway lifecycle](./gateway/lifecycle.md) — the full knowledge-loop walkthrough.
- [Example: AcmeAds](./examples/acme-ads.md) — a fictional ad-tech company using the kit end-to-end.
