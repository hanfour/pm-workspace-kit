---
sidebar_position: 4
---

# ADR-0003: Product Decision Log as a First-class ADR Class

- **Status:** Accepted
- **Date:** 2026-04-24
- **Deciders:** PM Lead, Architect
- **Tags:** product, methodology

## Context

Teams typically keep ADRs for technical decisions (framework, ORM, infra). Product-facing decisions — pricing, entitlement rules, feature gating, MVP scope — end up buried in PRD appendices, meeting notes, or Slack threads.

Six months later the questions come back:
- "Why is feature X only in the paid tier?"
- "Why did we decide to launch without bulk import?"
- "What was the rationale behind the 7-day trial length?"

And the answer is "ask Alex, they remember." If Alex leaves, the institutional memory leaves.

## Decision

Treat product decisions as first-class ADRs with the same format, review process, and status lifecycle as technical ADRs. File them in `docs/adr/` with a `product` tag and a sequential number.

### When to write a product ADR

- Pricing decision (tier structure, price point, billing cycle)
- Entitlement / feature gating (which plan gets what)
- MVP scope cut decisions ("we will not do X in v1")
- Launch strategy (geography, cohort, staged rollout)
- Terminology / naming (especially for customer-facing terms)
- Any decision that will be challenged by a future team member and needs rationale

### When not to

- Individual PRD content — lives in the PRD
- Reversible UX tweaks — PR description
- Tactical sprint-level decisions — sprint review notes

### Format

Same ADR template (`docs/templates/adr-template.md`). Difference is in Deciders: PM Lead as the primary decider, Architect as reviewer. Context section often cites market research, customer interviews, or pricing analysis instead of technical benchmarks.

## Consequences

### Positive
- Product decisions have a single, discoverable home.
- Cross-referenced from PRDs via `related.adr: [ADR-NNNN]`.
- Onboarding improves: new PMs can read the product ADR history and understand the product's shape.
- Deprecation is explicit: "we used to charge by seat, see ADR-0027; now we charge by usage, ADR-0051 supersedes."

### Negative
- PMs need to learn the MADR format (one-time cost).
- Not every PM buys in initially; takes a quarter of consistent use before it feels normal.
- Short-term: some PRDs will duplicate content from existing product ADRs until the habit is established.

### Neutral
- Product and technical ADRs share numbering — a single `ADR-NNNN` sequence, tagged differently.
- Product ADRs may cite customer data; redact / summarize if the repo is public.

## Alternatives Considered

### Alternative A: Keep product decisions in PRD appendices
- **Pros**: less new tooling.
- **Cons**: the problem this ADR addresses — information buried, un-discoverable, re-litigated.
- **Rejected**.

### Alternative B: Separate `docs/pdr/` (Product Decision Records) directory
- **Pros**: explicit separation.
- **Cons**: duplicate template, duplicate review process, two indexes to maintain. Artificial split.
- **Rejected**: same format wins; one directory, two tags.

### Alternative C: Use Confluence / Notion for product decisions, ADRs only for tech
- **Pros**: PMs may prefer the tool.
- **Cons**: defeats the "Git is source of truth" principle of this kit; creates cross-tool drift.
- **Rejected**.

## References

- Michael Nygard, "Documenting Architecture Decisions"
- [ADR-0001](./strangler-fig-protocol) — the methodology ADR pattern
- [Concepts: ADR Patterns](../concepts/adr-patterns)
