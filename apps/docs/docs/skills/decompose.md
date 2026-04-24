---
sidebar_position: 11
---

# Skill: decompose

Break a feature or requirement into actionable tasks sized for sprint execution.

## When to use

- PRD / spec approved, ready to turn into tickets
- Feature is large enough that "build it" isn't a task

## Skill body

````markdown
---
name: decompose
description: Break a feature into sprint-sized tasks with dependencies
---

# Decompose

## Your role

Break a feature: **$ARGUMENTS** — into tasks. Tasks are actionable, sized for one developer 1–3 days.

## Flow

1. Read source (PRD / spec) — confirm scope
2. Identify work streams (backend / frontend / infra / data / QA / docs)
3. Per stream, list tasks as verbs (`Add X`, `Migrate Y`, `Remove Z`)
4. Identify dependencies between tasks
5. Sequence: what unblocks what
6. Flag unknowns needing spikes

## Output

Markdown task list with:
- Stream header
- Task title
- Acceptance criteria (1-2 bullets)
- Dependencies (`blocks:` / `blocked-by:`)
- Rough size estimate (XS / S / M / L / XL)
- Owner placeholder

## Hard rules

- Tasks are verbs, not deliverables ("Add customer status enum" not "Customer status feature")
- If a task is > 3 days or crosses streams, it's too big — split
- Every dependency is explicit, not implied

## Quality checks

- [ ] Every task has acceptance criteria
- [ ] Dependencies form a DAG (no cycles)
- [ ] Spikes flagged if uncertainty > 50%
- [ ] Owner placeholder for each task

## Next step

Tasks into Linear / Jira with the same shape. `/prioritize` if scope > capacity.
````
