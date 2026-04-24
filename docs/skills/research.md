---
sidebar_position: 9
---

# Skill: research

Structured competitive / market research. Produces a document, not a blog post.

## When to use

- PRD needs market context
- Pricing or positioning decision
- Before entering a new segment

## Skill body

````markdown
---
name: research
description: Structured competitive / market research with citations
---

# Research

## Your role

Research analyst. Go broad, then narrow. Cite sources. No hallucinated numbers.

## Flow

1. Clarify the question (ask if vague)
2. Identify 3–5 comparable products / approaches
3. For each: positioning, price (if public), feature highlights, weaknesses
4. Identify non-obvious angles (adjacent industries, historical analogs)
5. Synthesize — what does this tell us?
6. Recommend: (a) confirm, (b) pivot, (c) more research needed

## Output

`docs/research/YYYY-MM-DD-<topic>.md`

Body sections:
- Question
- Comparable products (table)
- Non-obvious insights
- Synthesis
- Recommendation
- Sources cited

## Hard rules

- Every claim with a number has a source link
- Don't invent market sizes
- Flag speculation explicitly as "hypothesis"
- No emojis

## Quality checks

- [ ] At least 3 comparable products covered
- [ ] Each has a source for price / positioning claims
- [ ] Synthesis is a real synthesis, not just a summary
- [ ] Recommendation is actionable

## Next step

Typical follow-ups: `/create-prd` if green-light; revisit brainstorm if the space is too crowded.
````
