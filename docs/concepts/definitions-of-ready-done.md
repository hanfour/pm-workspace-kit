---
sidebar_position: 2
---

# Definitions of Ready / Done

A document type has two quality bars: one before anyone starts writing the body (**DoR**), one before anyone acts on it (**DoD**). Both are enforced by review, not script — the kit just gives each doc type a place to put the checklist.

## Why this, not a policy wiki

Wiki policies die in a drawer. Per-type checklists live next to the doc, show up in every review, and give reviewers a concrete question to ask besides "does this look OK?".

## The standard bars

### Requirement card (REQ-\*)

**Ready to intake** — the reporter has provided enough context:

- [ ] Background / pain point / affected role are all present
- [ ] One-liner problem statement is unambiguous
- [ ] Rough priority signal (Must / Should / Nice)

**Done (card is shipped to PM)**:

- [ ] Impact analysis aligned against the Ontology / domain model
- [ ] Complexity estimated (S / M / L / XL)
- [ ] Assigned PM owner
- [ ] `doc_id` issued

### PRD (PRD-\*)

**Ready to write**:

- [ ] Source requirement card is `Approved`
- [ ] Ontology lookup complete (upstream systems, affected entities identified)
- [ ] No conflicting PRD exists (search the traceability matrix + Confluence)
- [ ] Stakeholder list + decision-maker identified

**Done (ready to publish)**:

- [ ] `doc_id`, `related.requirement`, `related.module` all filled
- [ ] Every Must / Should / Could / Won't item has testable acceptance criteria
- [ ] Every success metric is SMART (specific, measurable, achievable, relevant, time-bound)
- [ ] Assumptions and risks listed with mitigations
- [ ] Three reviewers signed off (typical: PM Lead, Architect, lead engineer)
- [ ] Status moved from `Draft` → `In Review` or `Approved`

### Spec (SPEC-\*)

**Ready to write**:

- [ ] Corresponding PRD is `Approved`
- [ ] Technical owner confirmed
- [ ] Upstream API / module dependencies inventoried
- [ ] Relevant ADRs surfaced; new-decision ADRs drafted if needed

**Done**:

- [ ] `doc_id`, `related.prd`, `related.module` filled
- [ ] API contract complete with error codes and examples
- [ ] Data model aligned with Ontology
- [ ] Test strategy covers unit / integration / performance
- [ ] Deploy + rollback plans are executable, not aspirational
- [ ] Architect + one senior engineer signed off

### Plan (PLAN-\*)

**Ready to write**: whoever's on point has enough context and authority to commit a team.

**Done**:

- [ ] Milestones have dates or explicit "TBD pending X"
- [ ] Dependencies are named (both what it needs and what it unblocks)
- [ ] Rollback or abort condition is written down

## How to adapt the bars

You will have types this doesn't cover (decision docs, RFCs, ops runbooks). Add a checklist at the bottom of the relevant skill / template and link the skill or template from this page.

Don't copy every checkbox into every team policy. Pick the four that fail most often in your team's review history and enforce those.

## How the kit uses these

The PM skills shipped with Claude Code (see [Templates: Claude Skills](../templates/adr-template.md) — full skill catalog is on the roadmap) include the relevant checklists inline. A reviewer running `/create-prd` ends up with the DoR/DoD baked into the generated document.

If you're not using Claude Code, paste the checklist from this page into your PR template or the doc body itself — the goal is "reviewer has to consciously sign it off", not automation.

## Related

- [Concepts: Traceability](./traceability.md)
- [Guide: Handoff to Implementation](../guides/handoff-to-implementation.md)
