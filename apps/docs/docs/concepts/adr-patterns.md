---
sidebar_position: 3
---

# ADR Patterns

Architecture Decision Records (ADRs) capture **why** a choice was made. The code answers _what_; the ADR answers _why_. When someone on the team asks "can we just use X instead?" six months later, the ADR is how you avoid re-litigating.

This kit ships three **methodology** ADRs pre-written (Strangler Fig, Dev Harness, Product Decision Log). Everything else is yours to decide — the kit provides the format.

## Format (MADR-lite)

```markdown
# ADR-NNNN: <decision title>

- **Status:** Proposed | Accepted | Deprecated | Superseded by ADR-XXXX
- **Date:** YYYY-MM-DD
- **Deciders:** @owner, @reviewer-1
- **Tags:** backend, frontend, migration, ...

## Context
Why is this decision needed now? What are the constraints?

## Decision
What did we decide? Lead with one sentence. Then detail.

## Consequences

### Positive
- ...

### Negative
- ...

### Neutral
- Things to watch but not block on.

## Alternatives Considered

### Alternative A: <name>
- Pros:
- Cons:
- Rejected because:

### Alternative B: <name>
...

## References
- Links, prior ADRs, external docs.
```

The template is at [`docs/templates/adr-template.md`](../templates/adr-template).

## Two classes of ADR

### Technical ADRs (0001–0010 range, by convention)

Framework choice, database, messaging, deployment topology. Deciders are usually Architect + senior eng.

### Product Decision Records

Pricing tiers, entitlement rules, MVP scope, feature gating. Deciders are usually PM Lead + Architect. Same format, different domain. The kit's pre-written **ADR-0003: Product Decision Log** (shipped under `docs/adr/`) is a meta-ADR that makes this class first-class so these decisions stop being buried in PRD appendices.

## Retroactive ADRs

Sometimes a decision was made in a meeting three months ago and is already in production. Write the ADR anyway, mark `Status: Accepted` with a `Recorded: YYYY-MM-DD` note, fill in the Alternatives Considered from memory.

The audit trail exists, future-you stops guessing, and if a new team member challenges the decision you have a document to either defend or gracefully deprecate.

## When not to write an ADR

- Reversible, single-PR changes (naming conventions, lint rule, config value) — a PR description is enough.
- Decisions that'll be undone within a sprint.
- "How do we implement X" — that's a spec, not an ADR. ADRs are about **which** option to pick, not the playbook for one option.

## Deprecation and supersession

Don't delete an old ADR. Instead:

- Change its status to `Deprecated` and add a one-liner at the top explaining what replaces it.
- If a direct successor exists: `Superseded by ADR-NNNN` and cross-link.
- The reader lands on ADR-0042 "Use MySQL", sees it's deprecated, follows the link to ADR-0087 "Use Postgres", and gets the context for the shift.

## Filing convention

One ADR per file, numbered sequentially, in `docs/adr/`. Keep a `docs/adr/README.md` index (the kit provides one). Never reuse a number even if an ADR is abandoned — just mark it `Deprecated` and move on.

## Suggested ADRs to write early

For any non-trivial project:

1. **Monorepo strategy** (one repo? multiple? Turborepo / Nx / Lerna?)
2. **Backend framework** (Rails / Nest / FastAPI / Spring / Go stdlib)
3. **ORM / persistence layer**
4. **Migration protocol** — the kit provides ADR-0001 Strangler Fig; accept or adapt it.
5. **Dev harness / tool conventions** — the kit provides ADR-0002.
6. **Product decision log** — the kit provides ADR-0003.

## Related

- [Templates: ADR](../templates/adr-template)
- [Concepts: Strangler Fig](./strangler-fig)
