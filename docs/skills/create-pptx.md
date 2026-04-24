---
sidebar_position: 15
---

# Skill: create-pptx

Generate a PowerPoint deck from a markdown doc. Needs a PPTX generator (e.g. Anthropic Agent Skills API, `pptxgenjs`, or similar).

## When to use

- Stakeholder wants slides from an approved PRD
- Architecture review meeting needs a deck, not a doc
- Executive briefing

## Skill body

````markdown
---
name: create-pptx
description: Generate a PowerPoint deck from a markdown source (PRD / roadmap / architecture doc)
---

# Create PPTX

## Your role

Turn **$ARGUMENTS** (markdown source path) into a PowerPoint deck. The deck is for reading, not reading aloud — favor structure over prose.

## Flow

1. Read the source markdown
2. Determine audience (exec / engineering / stakeholder mix) and adjust slide density
3. Outline the deck:
   - Title slide
   - Agenda
   - Problem / Context
   - Solution / Proposal
   - Key sections (3–8 depending on source depth)
   - Metrics / Next steps
   - Questions
4. Generate the .pptx via the available tool (Anthropic Skills API, `pptxgenjs`, or similar)
5. Save to `docs/presentations/YYYY-MM-DD-<slug>.pptx`

## Slide density rule

- **Exec audience**: 1 main point per slide, < 8 words in title, chart > text
- **Engineering audience**: technical detail OK, bullets dense but scannable
- **Mixed**: exec style for first 3 slides, detail after

## Hard rules

- One idea per slide — don't cram
- Charts over tables; tables over prose
- Every claim has a source (doc path + section)
- No emojis in slide content

## Quality checks

- [ ] Deck length matches audience expectation (5 / 15 / 30 minutes)
- [ ] Every slide has a takeaway, not just a label
- [ ] Speaker notes present for exec slides
- [ ] Filename follows convention

## Next step

Share via company-standard slide tool. If feedback requires edits, regenerate from updated markdown rather than editing the .pptx directly.
````

## Tooling note

PPTX generation requires an external tool. Options:

- **Anthropic Agent Skills API** — invoke via HTTP with a template spec, receive `.pptx` bytes
- **`pptxgenjs`** — Node library; render markdown → deck programmatically
- **Google Slides API** — if team uses Google Workspace

The kit doesn't bundle a specific implementation; wire in whichever your tooling stack supports.
