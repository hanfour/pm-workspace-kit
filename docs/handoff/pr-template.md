---
sidebar_position: 2
---

# PR Template

Copy the block below into `.github/pull_request_template.md` in the implementation repo.

---

````markdown
## Summary

<!-- 1-3 sentences: what + why. Avoid describing only what. -->

## Traceability

- **REQ**: REQ-YYYY-NNNN (or N/A)
- **PRD**: PRD-YYYY-NNNN (or N/A)
- **Spec**: SPEC-YYYY-NNNN (or N/A)
- **Module**: <module_id> (or cross-cutting)
- **ADR**: ADR-NNNN (if architecture-affecting)
- **Confluence**: <page_id> (if published)

> CI `traceability-check` validates any new/modified files in `docs/prds/**`, `docs/specs/**`, `.claude/plans/**` carry required front-matter.

## Change type

- [ ] feat (new capability)
- [ ] fix (bug)
- [ ] refactor (behavior unchanged)
- [ ] perf
- [ ] docs
- [ ] test
- [ ] chore / build / ci

## Migration (if Strangler Fig applies)

- **Module**: <module_id>
- **Stage**: ☐ 0 Prep / ☐ 1 Shadow Read / ☐ 2 Double Write / ☐ 3 Cutover / ☐ 4 Retire
- **Feature flag**: `migration.<module>.mode = ...`
- **Reconciliation diff (24h)**: ___%  (must be below module SLO)
- **Co-signers for stage transition**: @reviewer-1, @reviewer-2

## Risk & Rollback

- **Risk tier**: ☐ P0 (money / PII / regulation) / ☐ P1 / ☐ P2 / ☐ P3
- **Blast radius**: ☐ single module / ☐ cross-module / ☐ cross-system (incl. external)
- **Rollback plan**: <feature flag / deploy revert / db migration down — target <5 min>
- **HITL impact**: ☐ unchanged / ☐ added / ☐ modified / ☐ removed (removal requires Architect sign-off)

## Verification

- [ ] Unit tests (coverage ≥ 80%)
- [ ] Integration tests (if DB / cross-module)
- [ ] E2E (if critical UI flow)
- [ ] Eval (if LLM prompt / tool)
- [ ] Local `npm run traceability:check` passes
- [ ] Ontology / schema validation passes (if applicable)

## Data / schema changes

- [ ] None
- [ ] Ontology YAML only (codegen regenerated; review generated artifacts)
- [ ] Migration included (up + down SQL; zero-downtime path documented)
- [ ] Cross-module structural change (requires ≥2 module-owner sign-offs)

## Notes for reviewers

<!-- Context reviewers need first: tradeoffs, known limits, follow-up work -->

## Screenshots / recordings (if UI)

<!-- -->

---

**PR title convention**: `<type>(<scope>): <imperative summary>`  
Example: `feat(billing.invoice): add partial-payment handling`
````

## Usage

- The template fires on every new PR. Keep _all_ sections; put `N/A` where not applicable.
- `Traceability` fields are the main CI gate. If you have nothing to cite, a reviewer should ask why.
- The `HITL impact` line is intentionally terse. Removing HITL on a financial write is a hard-blocker for merge regardless of who approved — see [Code Review Checklist](./code-review-checklist.md).
