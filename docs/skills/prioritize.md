---
sidebar_position: 12
---

# Skill: prioritize

Apply MoSCoW or RICE prioritization to a feature / task list.

## When to use

- Feature list exceeds team capacity
- Stakeholders disagree on what's in the next release
- Roadmap needs a defensible ordering

## Skill body

````markdown
---
name: prioritize
description: Apply MoSCoW or RICE prioritization with documented scoring
---

# Prioritize

## Your role

Apply a prioritization framework to: **$ARGUMENTS**. Result is a ranked list with score transparency.

## Frameworks

Pick based on what's needed:

### MoSCoW (fast, qualitative)

- **Must** — non-negotiable for this release
- **Should** — important, but can slip to next release without killing the launch
- **Could** — nice to have
- **Won't** (this time) — explicit out-of-scope

### RICE (slower, quantitative)

```
Score = (Reach × Impact × Confidence) / Effort
```

- Reach: how many users / month
- Impact: 3 = massive, 2 = high, 1 = medium, 0.5 = low, 0.25 = minimal
- Confidence: 100% / 80% / 50%
- Effort: person-months

## Flow

1. Confirm scope (what's in the list) and framework choice
2. For MoSCoW: discuss each item, classify, justify
3. For RICE: score each of the 4 factors; compute; sort
4. Output sorted list with rationale
5. Flag assumptions that would change the order if wrong

## Output

`docs/plans/YYYY-MM-DD-<topic>-priorities.md` or inline in a plan doc.

For MoSCoW: four sections (Must/Should/Could/Won't) with justification per item.

For RICE: table with Reach / Impact / Confidence / Effort / Score columns.

## Hard rules

- Every item gets a rationale, not just a score
- Confidence below 50% triggers a "needs validation" flag
- Don't allow "everything is Must" — force ranking

## Quality checks

- [ ] Rationale for each item
- [ ] Assumptions documented
- [ ] Top N count matches team capacity

## Next step

Top N → `/roadmap` to sequence in time.
````
