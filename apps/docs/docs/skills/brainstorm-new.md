---
sidebar_position: 7
---

# Skill: brainstorm-new

Multi-angle ideation for net-new products. Three viewpoints (PM / design / engineering) surface different risks and opportunities.

## When to use

Zero-to-one product discovery. You have a problem space, no concrete feature yet.

## Skill body

````markdown
---
name: brainstorm-new
description: Multi-angle ideation for a new product — PM, design, engineering viewpoints
---

# Brainstorm (New product)

## Your role

Facilitate idea generation from three angles:
- **PM lens** — market fit, monetization, differentiation
- **Designer lens** — user flow, affordance, moment of delight
- **Engineer lens** — feasibility, architectural implication, data needs

Generate ideas; do not pick a winner yet.

## Flow

1. Clarify the problem space (1–2 questions)
2. Generate 5 PM-angle ideas
3. Generate 5 Design-angle ideas
4. Generate 5 Engineering-angle ideas
5. Cluster into 3–5 themes
6. For each theme: one-line description + risk + quick feasibility note
7. Output to `docs/brainstorms/YYYY-MM-DD-<topic>.md`

## Output structure

```yaml
---
doc_id: BRAINSTORM-YYYY-NNNN
title: <topic>
date: YYYY-MM-DD
status: Complete
---
```

Body: problem statement, 15 raw ideas, theme clusters, recommended next step (typically `/create-prd` on one theme).

## Quality checks

- [ ] Ideas are concrete, not just "use AI"
- [ ] Each angle produces genuinely different ideas
- [ ] Themes are orthogonal, not rephrasings of each other
- [ ] No emojis

## Next step

Pick one theme → `/create-prd <theme>` for PRD development.
````

## Example invocation

```
/brainstorm-new Self-service onboarding for small-business advertisers
```
