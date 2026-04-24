---
sidebar_position: 13
---

# Skill: roadmap

Sequence prioritized features into a time-based plan. Quarterly / annual horizon.

## When to use

- After `/prioritize` — you know what, need to sequence
- Before stakeholder roadmap review
- Annual / half-year / quarterly planning

## Skill body

````markdown
---
name: roadmap
description: Sequence prioritized features into a time-based roadmap with dependencies
---

# Roadmap

## Your role

Sequence prioritized features into a time plan: **$ARGUMENTS**.

## Flow

1. Confirm the prioritized list (source: output of `/prioritize` typically)
2. Confirm the horizon (quarter / half-year / year) and team capacity
3. Build a Gantt-like sequence accounting for:
   - Dependencies between features
   - Team capacity per unit
   - External constraints (marketing, legal, partner launches)
4. Identify risk: what, if slipping, wrecks the plan
5. Output: Mermaid Gantt + prose narrative

## Output structure

```yaml
---
doc_id: ROADMAP-YYYY-Q#
title: <scope> roadmap
owner: "@<pm-handle>"
status: Draft
date: YYYY-MM-DD
horizon: Q#-YYYY
---
```

Body:

1. Horizon + team capacity assumptions
2. Features in sequence (Mermaid Gantt)
3. Key dependencies
4. Risks (what slips → what else slips)
5. Kill-switch criteria (when do we drop something)
6. Review cadence

## Mermaid Gantt example

```
gantt
  title Q3 2026 roadmap
  section Core
  Customer onboarding     :a1, 2026-07-01, 6w
  Invoice export          :a2, after a1, 3w
  section Platform
  Observability upgrade   :b1, 2026-07-01, 4w
```

## Hard rules

- Dates are quarters / months, not specific days unless pinned externally
- Every feature links back to a PRD doc_id
- Risks name the downstream consequence, not just the risk

## Quality checks

- [ ] Capacity math works (total effort ≤ team size × weeks)
- [ ] Every feature has a PRD citation
- [ ] At least 1 kill-switch criterion per feature
- [ ] Review cadence stated

## Next step

Publish to stakeholders; revisit at end of each review cycle.
````
