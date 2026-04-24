---
sidebar_position: 3
---

# Code Review Checklist

**Goal**: reviews focus on what humans judge best. What's already automated is not re-checked manually.

## 0. Automated gates (CI already enforces — reviewers skip)

- Lint, typecheck, unit tests, ontology validation, traceability check — all green
- Coverage ≥ 80% for modules in scope
- Bundle size no regression

If CI is red, reviewer doesn't need to read the diff.

## 1. Scope & intent

- [ ] PR title and summary match the actual diff (no "while I was here" payloads)
- [ ] Traceability fields complete — at least one of REQ / PRD / Spec / Module / ADR cites the source
- [ ] If touching 3+ modules, either split the PR or explicitly justify the cross-cut

## 2. Architectural consistency

- [ ] Follows the project's 10 principles (domain-first boundary, single source of truth, type-safe end-to-end, no `any`)
- [ ] No anti-patterns: frontend doing backend's job, business logic in an ORM callback, bypassing ontology codegen

## 3. Ontology / schema compliance

- [ ] New entity or field changes went through YAML + codegen, not hand-written schema
- [ ] Affected module playbook's Ontology Coverage section updated in the same PR or follow-up
- [ ] PII tier annotated (if new `confidential` / `restricted` fields)

## 4. Domain boundaries

- [ ] Controllers / route handlers do HTTP binding only; no business logic
- [ ] Cross-module calls go through event bus, not direct service calls
- [ ] Aggregates protect invariants — no external mutation of child entities
- [ ] New value objects centralize validation (Money / DateRange / VatNumber)

## 5. Migration discipline (Strangler Fig)

- [ ] PR description's stage matches the actual code behavior
- [ ] If dual-writing: new fields added to both old and new schemas in the same PR
- [ ] Reconciliation metrics for affected module within SLO
- [ ] Stage transition has two sign-offs, correct feature flag

## 6. AI / agent changes

- [ ] New tool defined via ontology codegen (5 standard CRUD) or explicitly under `custom/`
- [ ] `side_effects: write` tools have HITL rules (threshold or unconditional)
- [ ] Prompts are version-tagged with a changelog
- [ ] New prompt or tool has at least one eval regression case

## 7. Security & privacy

- [ ] AuthN/Z correct — new endpoints have `@Roles` + appropriate `@Policy`
- [ ] No PII leaks to log, prompt, or response body
- [ ] No hardcoded secrets
- [ ] Input validation at system boundary (controller DTO, server action, webhook)

## 8. Test quality

- [ ] Test names read as specifications (not "testFooBar")
- [ ] Edge cases covered (nil, empty, malformed, concurrent)
- [ ] Tests are order-independent; no hidden fixture leakage
- [ ] Bug-fix PRs include a **regression test** that fails before the fix

## 9. Observability

- [ ] New service methods have OTel spans (auto or manual)
- [ ] Business errors classified with `DomainError` / `ValidationError` — no generic `Error` thrown
- [ ] New alerts or dashboard panels follow-up ticketed if not in this PR

## 10. Readability

- [ ] File ≤ 800 lines (target 200–400)
- [ ] Function ≤ 50 lines
- [ ] No nesting > 4 levels
- [ ] Names reveal intent; no magic numbers
- [ ] Comments only for "why this way" — no comments restating the code

## Hard-blockers (cannot merge, even with approvals)

- ❌ Bypassing ontology codegen (hand-editing `generated/` files)
- ❌ Removing HITL on financial / PII / irreversible actions
- ❌ Coverage regression below PR baseline
- ❌ New `any` / `@ts-ignore` / `eslint-disable` without explicit comment justifying it
- ❌ Secrets / keys visible in the diff

## Comment conventions

| Prefix | Meaning | Author expected to |
|---|---|---|
| `blocking:` | must be fixed before merge | address |
| `nit:` | personal preference, small suggestion | may ignore |
| `question:` | understanding the design | respond |
| `praise:` | worth calling out | no action |
| `idea:` | future improvement | open follow-up issue |
