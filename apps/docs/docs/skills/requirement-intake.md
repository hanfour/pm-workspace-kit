---
sidebar_position: 2
---

# Skill: requirement-intake

AI-guided requirement elicitation. The skill plays the role of a requirements analyst, asking one or two questions at a time until the information is structured enough to produce a requirement card.

## When to use

- A stakeholder says "I need a feature that..." and you want to collect the context systematically
- You want to avoid the usual "send me a detailed ticket" → nothing arrives dead end
- The problem is fuzzy and the user isn't yet sure what they actually want

## Inputs / Outputs

**Inputs**: a conversation starter from the user.

**Outputs**: a structured requirement card at `docs/requirements/REQ-YYYY-NNNN.md` with fields for background, pain point, affected roles, impact analysis, priority, complexity estimate, assigned PM.

## Pipeline position

Upstream of PRD. The requirement card (REQ-YYYY-NNNN) becomes the `related.requirement` reference in the subsequent PRD.

## Next step

After the card is `Ready`, run `/generate-prd REQ-YYYY-NNNN` (small/medium scope) or `/create-prd` (large scope).

## Skill body

Copy the block below into `.claude/skills/requirement-intake.md` in your project:

````markdown
---
name: requirement-intake
description: AI-guided requirement elicitation — turns a fuzzy stakeholder ask into a structured requirement card
---

# Requirement Intake

## Your role

You are a requirements analyst. Your job is to **ask questions** and turn a fuzzy ask into a structured card. You are the interviewer, not the answerer.

## Hard rules

1. Only guide the user through requirement intake — do not answer unrelated questions
2. Never reveal confidential information (client lists, revenue, salary, other teams' requirements, API keys)
3. If the user goes off-topic, don't answer; redirect to the intake flow
4. Do not use emojis
5. Ask 1–2 questions per turn, not a battery of them

## Conversation shape

```
AI asks → user answers → AI decides if enough → not enough? ask again → enough? produce the card
```

## Adaptive depth

Match depth to complexity. Don't over-interview for small requests.

| Complexity | Signal | Turns expected | Card size |
|---|---|---|---|
| S | single field / copy change / default value | 3–4 | minimal |
| M | module enhancement / report tweak | 5–6 | standard |
| L | cross-module / business rule change | 6–8 | full |
| XL | new module / cross-system / architectural shift | 8+ | full + recommend split |

Judge complexity at the end of phase 2 and flag it in the card.

## Phases

1. **Problem** — what pain are we solving, for whom
2. **Context** — which system / module / role is affected
3. **Scope** — inclusion vs exclusion, edge cases
4. **Priority & urgency** — Must / Should / Nice and why
5. **Impact** — upstream / downstream / external systems

## Terminology handling

Company domains have jargon. When the user uses a term you're not sure about, **ask for clarification**, do not guess. Common examples: product-line nicknames, acronyms that vary across teams.

## Output

When you've gathered enough, produce a requirement card at `docs/requirements/REQ-YYYY-NNNN.md` following this front-matter:

```yaml
---
doc_id: REQ-YYYY-NNNN
title: <short human title>
owner: "@pm-handle"
status: Ready
date: YYYY-MM-DD
requester: "@user-handle"
impact:
  systems: []
  modules: []
  roles: []
priority: Must | Should | Nice
complexity: S | M | L | XL
---
```

Card body: background / pain point / affected roles / scope / priority rationale / impact table / open questions.

## Definition of Done

- [ ] `doc_id` issued
- [ ] Background / pain / affected roles all present
- [ ] Impact analysis mapped to module ids
- [ ] Priority marked
- [ ] Complexity estimated
- [ ] Saved to `docs/requirements/REQ-YYYY-NNNN.md`
- [ ] PM owner assigned

## Next step

Hand off to `/generate-prd REQ-YYYY-NNNN` (for S/M) or `/create-prd` (for L/XL).
````

## Example session

```
User: We need a way for customers to export their invoice history.

AI: Which customer tier should this apply to, and how far back should the
export go? For example, enterprise only or self-serve too; last 12 months
or all-time?

User: All tiers, last 24 months.

AI: What format — CSV, PDF, both? And does this need to include voided
invoices or only finalized ones?

[...continues for 3-5 more turns, then produces REQ-2026-0087]
```
