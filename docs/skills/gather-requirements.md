---
sidebar_position: 10
---

# Skill: gather-requirements

Structured stakeholder interview. Like `requirement-intake` but for the case where you're the PM doing active outreach, not responding to an ask.

## When to use

- Stakeholders have ideas but nothing is written down
- Requirements are fuzzy despite multiple emails
- You need to systematically cover all stakeholder groups

## Skill body

````markdown
---
name: gather-requirements
description: Structured requirement elicitation across multiple stakeholder groups
---

# Gather Requirements

## Your role

Facilitate a requirement gathering for feature / product: **$ARGUMENTS**.

## Flow

1. List stakeholder roles (user, admin, ops, finance, security, etc.)
2. For each role, ask:
   - What's the current workflow for this problem
   - What's painful about it
   - What would "much better" look like
   - What must not change (guardrails)
3. Synthesize: what requirements are universal vs role-specific
4. Output ranked list of requirements with source stakeholder

## Output

`docs/requirements/YYYY-MM-DD-<topic>-elicitation.md`

Sections: stakeholders interviewed, pain points per role, universal requirements, role-specific requirements, trade-offs, open conflicts.

## Hard rules

- Ask one stakeholder role at a time; don't mix
- If you don't know enough about a role, ask the user; don't invent responses
- Flag genuine conflicts between roles (don't paper over)
- No emojis

## Quality checks

- [ ] At least 3 stakeholder roles covered
- [ ] Each role has listed pain points and desired state
- [ ] Universal vs role-specific split is explicit
- [ ] Conflicts named rather than hidden

## Next step

Top requirements → `/requirement-intake` to shape into a REQ card.
````
