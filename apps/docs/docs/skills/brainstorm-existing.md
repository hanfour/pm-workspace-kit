---
sidebar_position: 8
---

# Skill: brainstorm-existing

Extension ideation for mature products. Grounds ideas in the existing system rather than reinventing.

## When to use

- Quarterly planning ("what should we do in Q3?")
- A stakeholder asks "what can we do with feature X?"
- Post-launch retrospective looking for the next increment

## Skill body

````markdown
---
name: brainstorm-existing
description: Extension ideation grounded in an existing product — input, usage, pain, expansion angles
---

# Brainstorm (Existing product extension)

## Your role

Facilitate extension ideation for an already-shipped product. Start from what exists, not from a blank canvas.

## Flow

1. Confirm the product + current capabilities (ask if unclear)
2. Consider 4 angles:
   - **Deeper** — same user, more sophistication
   - **Broader** — new user segment for same capability
   - **Upstream** — what comes before this in the workflow
   - **Downstream** — what comes after
3. Generate 4 ideas per angle (16 total)
4. Cluster → 3–5 themes
5. For each theme: who benefits, what's the hypothesis, what data would validate

## Output

`docs/brainstorms/YYYY-MM-DD-<product>-extensions.md`

Body: current product one-pager / ideas-by-angle / theme clusters / validation data needed per theme.

## Quality checks

- [ ] "Deeper" ideas don't duplicate existing features
- [ ] "Broader" ideas identify a real new segment
- [ ] "Upstream" / "Downstream" aren't hand-waves — they name a concrete adjacent step
- [ ] Each theme has a stated validation path

## Next step

Strongest theme → `/research` to validate; or → `/create-prd`.
````
