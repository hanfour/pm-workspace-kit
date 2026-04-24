---
sidebar_position: 4
---

# Skill: create-prd

Interactive PRD authoring, for large-scope or greenfield features. Unlike `/generate-prd` (which runs mostly autonomously from a requirement card), `/create-prd` walks the user through each section asking targeted questions.

## When to use

- New product or major feature (greenfield, no requirement card yet)
- Scope marked as L or XL in the requirement card
- Stakeholders want to be part of shaping the PRD, not review a draft

## Inputs / Outputs

**Inputs**: a short pitch or problem statement from the user.

**Outputs**: `docs/prds/YYYY-MM-DD-<slug>-prd.md`, shaped by a guided conversation.

## Skill body

````markdown
---
name: create-prd
description: Interactive PRD authoring for greenfield or large-scope features, guided by PM questions
---

# Create PRD (interactive)

## Your role

Senior PM collaborating with the author. Ask discerning questions, push back on vague goals, insist on measurable outcomes.

## Context

Feature / product being designed: **$ARGUMENTS**.

If the user uploaded a brainstorm output or research doc, read it first.

## Flow

1. **Requirement discovery**
   Ask about:
   - What problem does this solve
   - Target user persona
   - Success measure (quantified)
   - Constraints (time, tech, budget)
   - Greenfield or brownfield extension

2. **Structured PRD drafting**
   Walk section by section; confirm before moving on.

3. **Review & confirm**
   Flag unresolved items explicitly. Don't invent them.

## PRD output format

```yaml
---
doc_id: PRD-YYYY-NNNN
title: <title>
owner: "@<handle>"
status: Draft
date: YYYY-MM-DD
related:
  requirement: []
  plan: []
  spec: []
  architecture: []
  adr: []
  module: []
  confluence_page_id: null
---
```

Sections:

1. Overview — problem, vision, goals
2. Target users — personas, journeys
3. Functional requirements — Must / Should / Could / Won't
4. Non-functional requirements — performance, availability, security
5. Technical considerations — architecture, integrations, data
6. Success metrics
7. Timeline & milestones
8. Assumptions & risks
9. Open questions
Appendix

## Quality checklist

- [ ] Problem statement clear
- [ ] Target user specific
- [ ] Functional requirements have acceptance criteria
- [ ] Non-functional have quantitative targets
- [ ] Success metrics SMART
- [ ] Scope boundaries explicit (what's not in v1)
- [ ] Assumptions + risks listed
- [ ] Timeline realistic

Save to `docs/prds/`.

## Definition of Ready

- [ ] Requirement card approved (if one exists) or problem statement is concrete
- [ ] Ontology lookup done
- [ ] Confluence dedup search done
- [ ] Stakeholders + decision-maker identified
- [ ] Business goal aligned with requester

## Definition of Done

- [ ] `doc_id`, `related.requirement`, `related.module` filled
- [ ] Every Must / Should / Could / Won't item has testable acceptance criteria
- [ ] Success metrics SMART
- [ ] Assumptions + risks have mitigations
- [ ] 3 reviewers signed off (PM Lead, Architect, lead engineer typical)
- [ ] Status moved Draft → In Review or Approved

## Next step

1. `/write-spec` for technical detail if needed
2. `/publish-to-confluence` to push it for review; page id writes back into front-matter
````

## Example invocation

```
/create-prd Self-serve customer onboarding
```

The skill starts an interactive session, asking about target user, pain being solved, quantified success, constraints, then builds the PRD section by section.
