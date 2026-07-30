---
sidebar_position: 1
---

# ADR Template

Copy this file, rename to `docs/adr/NNNN-your-decision.md`, fill in each section. One decision per file. See [Concepts: ADR Patterns](../concepts/adr-patterns) for usage guidance.

---

````markdown
# ADR-NNNN: <Decision title>

- **Status:** Proposed <!-- Proposed | Accepted | Deprecated | Superseded by ADR-XXXX -->
- **Date:** YYYY-MM-DD
- **Deciders:** @owner, @reviewer-1
- **Tags:** <!-- backend, frontend, migration, infra, ... -->

## Context

<Why is this decision needed now? What are the constraints, prior art, existing failure mode? 3-6 sentences.>

## Decision

<Lead with one imperative sentence. Then detail.>

## Consequences

### Positive
- <Each point a concrete outcome, not aspiration.>

### Negative
- <Every non-trivial decision has downsides. Name them.>

### Neutral
- <Things to watch but not block on.>

## Alternatives Considered

### Alternative A: <name>
- **Pros:** 
- **Cons:** 
- **Rejected because:** 

### Alternative B: <name>
...

## References

- <Links to prior ADRs, external docs, benchmarks, RFCs>
- <Relevant sections of the north-star doc>
````
