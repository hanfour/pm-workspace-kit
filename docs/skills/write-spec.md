---
sidebar_position: 5
---

# Skill: write-spec

Translate an approved PRD into an engineering-ready technical specification.

## When to use

- PRD is `Approved`
- Engineering needs API contracts, data model, test plan
- The spec needs to drive ticketing, not a general discussion

## Skill body

````markdown
---
name: write-spec
description: Turn an approved PRD into a technical spec with API contracts, data model, and test strategy
---

# Write Spec

## Your role

Senior engineer turning product intent into implementation-ready detail. PM has decided what; you decide how, where the boundaries are, and how it's tested.

## Context

Source PRD: **$ARGUMENTS**. Read it first.

## Flow

1. **Translate requirements** — product language → technical. List tech decisions + assumptions.
2. **Architecture design** — high-level, API contracts, data model, error handling.
3. **Implementation guide** — pseudocode where useful, test strategy, deployment notes.

## Output format

```yaml
---
doc_id: SPEC-YYYY-NNNN
title: <spec title>
owner: "@<eng-handle>"
status: Draft
date: YYYY-MM-DD
related:
  prd: [PRD-YYYY-NNNN]
  plan: []
  architecture: []
  adr: []
  module: []
---
```

Body sections:

1. Overview — background, goals, non-goals
2. System architecture — diagram (Mermaid), components, data flow
3. API design — endpoints, request/response shapes, errors
4. Data model — entities, relations, indexes
5. Security — auth, authorization, data protection, input validation
6. Performance — QPS, latency targets, caching, query optimization
7. Test strategy — unit, integration, performance
8. Deployment — method, env vars, monitoring, rollback
9. Open questions / decisions

Save to `docs/specs/`.

## Definition of Ready

- [ ] Source PRD is `Approved`
- [ ] Technical owner confirmed
- [ ] Upstream API / module dependencies inventoried
- [ ] Relevant ADRs checked; new ones drafted if needed

## Definition of Done

- [ ] `doc_id`, `related.prd`, `related.module` filled
- [ ] API contract includes error codes and examples
- [ ] Data model aligned with Ontology
- [ ] Test strategy covers unit / integration / performance
- [ ] Deploy + rollback plans actionable
- [ ] Architect + one senior engineer signed off

## Next step

1. Engineering scopes into sprint; spec enters Implementation status
2. If cross-module impact, reference this spec in each affected module playbook
3. Optionally `/publish-to-confluence` for non-eng reviewers
````

## Example invocation

```
/write-spec PRD-2026-0015
```

Produces `docs/specs/2026-04-24-customer-invoice-export-spec.md` with API / data model / test strategy tuned to the approved PRD.
