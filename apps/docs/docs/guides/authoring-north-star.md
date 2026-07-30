---
sidebar_position: 3
---

# Authoring a North Star Architecture Doc

A north star document tells everyone — engineering, PM, finance, execs — where the system is going over 12–36 months. It's long, it's opinionated, and the kit provides a 10-chapter scaffold so you don't stare at an empty page.

## When to write one

- You're planning a platform migration (monolith → service-oriented, Ruby → TS, etc.)
- A new product requires architectural choices that will outlive the current team
- The current system has "just works" mystery areas and you need a shared map

If the answer is "to decide one feature", it's a PRD, not a north star. Use the right tool.

## The 10 chapters

| # | Chapter | Owner | Stabilizes |
|---|---|---|---|
| 0 | Executive Summary | PM Lead + Architect | Sprint 0 |
| 1 | As-Is assessment | Architect | Sprint 1 |
| 2 | Vision & Principles | PM Lead | Sprint 1 |
| 3 | To-Be architecture | Architect | Sprint 1 |
| 4 | Pillar I (e.g. data model) | Architect | Sprint 2 |
| 5 | Pillar II (e.g. harness / tooling) | Architect | Sprint 2 |
| 6 | Pillar III (e.g. AI / platform capability) | Architect | Sprint 2 |
| 7 | Roadmap (multi-stage) | PM Lead | Sprint 2 |
| 8 | Migration Strategy | Architect | Sprint 3 |
| 9 | Cross-cutting concerns | Architect | Sprint 3 |
| 10 | ADR Index (pointer) | — | Evolves |
| Appendix | Glossary, terminology map, worked example | All | Sprint 3 / ongoing |

The kit's **[north-star outline template](../templates/adr-template)** is what you copy to start. (Full outline as a standalone template file is on the roadmap — for now, use this chapter list.)

## Writing order: outline first, prose second

Counter-intuitively, prose last:

1. **Sprint 0 (one day)**: Write Ch.0 Executive Summary as best you can. Commit it. Then skeleton Ch.1–10 with just sub-headings. Yes, the doc looks embarrassingly sparse. That's the point.
2. **Sprint 1 (one to two weeks)**: Fill Ch.1 As-Is, Ch.2 Vision, Ch.3 To-Be. Force yourself to use Mermaid for C4 diagrams, not hand-drawn PNGs.
3. **Sprint 2**: Fill Ch.4–7. These are the "how it works" chapters. Each pillar gets its own dedicated sub-chapters.
4. **Sprint 3**: Ch.8 Migration and Ch.9 Cross-cutting. By now enough is stable that these can be concrete.
5. **Appendix fills in as you go** — especially the glossary. The instant someone asks "what do you mean by X?" in review, the answer goes in the glossary.

## Writing rules

### Lead with why, not what

Each chapter opens with "why this matters". Readers who skim should still understand why the chapter exists before they hit the technical detail.

### Quantify everything that's quantifiable

"Reconcile within tolerance" is worthless. `< 0.01% row-level diff over 14 days` is a test condition. Every SLO, every threshold, every migration exit criterion — make it a number.

Mark guesses explicitly: `reconcile tolerance: < 0.01% (target; validate in Stage 0 load test)`. Future you will know which numbers are measured vs aspirational.

### Anti-patterns go in a dedicated subsection

Ch.2 (Principles) should have an "Anti-patterns" section listing what _not_ to do. Easier to write and review than principles alone. "Don't let frontend call the database directly" is more concrete than "respect domain boundaries".

### Cite ADRs, don't inline decisions

Long-form decisions belong in an ADR. The north star cites `ADR-0005` and explains the consequence. Otherwise the doc becomes a swamp.

## What to do with the doc once it's stable

- **Review cadence**: quarterly. Changelog at the top. Major re-organization is rare; Appendix and ADR Index grow organically.
- **Source of truth for**: architectural questions, migration status, Roadmap stage. If the answer is "ask the architect", the answer should be in the north star.
- **Not the source of truth for**: tickets, sprint planning, individual PRDs. Those live in Linear / Jira / the PRD itself.

## What to review

When reviewing someone else's north star draft:

1. **Does Ch.0 stand alone?** A reader who reads only Ch.0 + Ch.7 Roadmap should be able to brief a VP.
2. **Are Ch.1 numbers real?** As-Is should cite actual metrics (latency, failure rates, LOC), not guesses.
3. **Do Ch.2 principles have anti-examples?** If not, they're aspirational noise.
4. **Does Ch.8 migration reference a real protocol?** The kit's ADR-0001 Strangler Fig is the default. A bespoke protocol needs its own ADR.
5. **Are SLOs in Ch.9 testable?** `high availability` is vague. `p95 < 250ms, error rate < 0.1%` is testable.

## Related

- [Concepts: ADR Patterns](../concepts/adr-patterns)
- [Concepts: Strangler Fig](../concepts/strangler-fig)
- [Templates: Module Playbook](../templates/module-playbook-template)
