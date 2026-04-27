---
sidebar_position: 3
---

# Skill: generate-prd

Auto-generate a full PRD from a structured requirement card. Uses the Ontology (if present) and existing Confluence content to avoid conflicts.

## When to use

- Requirement card (REQ-YYYY-NNNN) is `Ready`
- Scope is small or medium (per the card's `complexity` field)
- You want a PRD draft in minutes, to then iterate on

## Inputs / Outputs

**Inputs**: REQ-YYYY-NNNN reference or the card's path.

**Outputs**: `docs/prds/YYYY-MM-DD-<slug>-prd.md` with full front-matter + 13 sections.

## Pipeline position

Between requirement card and spec. Links back to the source REQ in `related.requirement`.

## Skill body

````markdown
---
name: generate-prd
description: Auto-generate a PRD from a structured requirement card, including Ontology lookups and Confluence dedup
---

# Generate PRD

## Your role

You are the product manager. Given a structured requirement card, produce a PRD a reviewer can critique and engineering can act on.

## Input

A requirement card, from one of:
- `docs/requirements/REQ-YYYY-NNNN.md`
- Content pasted by the user
- A requirement id (`REQ-YYYY-NNNN`)

## Knowledge sources

Before writing, consult:

1. **Ontology YAML** (if present) — `ontology/systems/*.yaml`, `ontology/links.yaml`, `ontology/departments.yaml` — for entity definitions and cross-system impact
2. **Confluence** (if available via tool) — search for existing PRDs that overlap
3. **Local source code** (if tool available) — model / API / component definitions

## PRD structure

```yaml
---
doc_id: PRD-YYYY-NNNN
title: <title>
owner: "@<pm-handle>"
status: Draft
date: YYYY-MM-DD
related:
  requirement: [REQ-YYYY-NNNN]
  plan: []
  spec: []
  architecture: []
  adr: []
  module: []
  confluence_page_id: null
---
```

Body sections:

1. Executive Summary (one paragraph)
2. Problem Definition — current pain + desired outcome
3. Goals & Success Metrics — SMART KPIs
4. User Personas
5. Functional Requirements — per module
6. User Stories — 3-5 with testable acceptance criteria
7. UI / UX Specs (if applicable)
8. Data Model (reference Ontology entities)
9. API Design (RESTful or tRPC)
10. Non-functional Requirements
11. MoSCoW Prioritization
12. Risks & Assumptions
13. Open Questions
Appendix: changelog

## Size adjustment

Don't write a full PRD for a small requirement. Match depth to the card's `complexity`:

| Size | Section depth |
|---|---|
| S | sections 1–6, skip API/data model |
| M | full sections |
| L | full + architecture diagrams |

## Output

1. Save PRD to `docs/prds/{date}-{slug}-prd.md`
2. Optionally publish via `/publish-to-confluence`
3. Report the file path + (if published) Confluence page id

## Quality checks

Before calling it done:

- [ ] Ontology entities and fields cited
- [ ] Cross-system impact mapped (`links.yaml`)
- [ ] Confluence dedup search done
- [ ] User story acceptance criteria are testable
- [ ] API design consistent with existing style
- [ ] Open questions each have an owner
- [ ] Size matches requirement complexity — don't over-engineer small ones
- [ ] No emojis in the output

## Definition of Ready

- [ ] Requirement card exists and is `Ready`
- [ ] Ontology lookup completed
- [ ] Confluence search completed (dedup check)
- [ ] Complexity estimated from card

## Definition of Done

- [ ] `doc_id`, `related.requirement`, `related.module` filled
- [ ] Every Must/Should/Could/Won't item has acceptance criteria
- [ ] Success metrics SMART
- [ ] MoSCoW priority done
- [ ] Each open question has a named owner
- [ ] Saved to `docs/prds/`

## Next step

1. Human review loop — stakeholders comment, status moves `Draft` → `In Review`
2. On approval: `/publish-to-confluence`
3. If tech spec needed: `/write-spec` with the PRD as input
````

## Example invocation

```
/generate-prd REQ-2026-0087
```

The skill reads the requirement card, consults Ontology, searches Confluence, then emits `docs/prds/2026-04-24-customer-invoice-export-prd.md`.
