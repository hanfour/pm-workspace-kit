---
sidebar_position: 1
---

# Traceability Matrix — Usage Guide

A step-by-step walkthrough of the `traceability.js` script: what it reads, what it produces, how to wire it into CI, and how to read the resulting matrix.

## What it reads

By default, the script scans these directories for markdown files with `doc_id` front-matter:

```
docs/prds/
docs/specs/
docs/plans/
docs/requirements/
docs/handoff/
.claude/plans/
```

Edit `SCAN_DIRS` in `scripts/traceability.js` to add or remove paths.

## Commands

```bash
# Regenerate the matrix (writes docs/traceability-matrix.md)
npm run traceability:matrix

# Validate required front-matter fields across all tracked docs
npm run traceability:check

# Validate specific files only (useful in pre-commit hooks)
node scripts/traceability.js check docs/prds/2026-Q3-example.md
```

## What the matrix contains

Open `docs/traceability-matrix.md` after running `matrix`. Five sections:

### 1. Summary
Totals by doc type (PRD / SPEC / PLAN / HANDOFF / ...), edge counts by type (requirement / adr / module / ...).

### 2. Flat table
One row per primary doc. Columns for `doc_id`, title, status, each kind of related reference, and the file path.

### 3. Dependency graph
Mermaid `graph LR`. Color-coded by doc type. Primary nodes are rectangles; **virtual** nodes (targets referenced but not themselves tracked — typical for ADRs, modules, architecture paths) are rounded rectangles.

Renders directly in GitHub, GitLab, Docusaurus, Obsidian, and VS Code's markdown preview.

### 4. Reverse lookup (backlinks)
For every target with at least one incoming reference, lists who points at it and through which `related.*` key.

This is the answer to "if I deprecate ADR-0011, who breaks?".

### 5. Orphans & isolation
Two lists:

- **Docs with no outgoing references** — they don't cite anything upstream. Acceptable for standalone retrospectives; suspicious for PRDs that should cite requirements.
- **Primary-to-primary citation count** — what fraction of tracked docs cite another tracked doc by `doc_id`. If zero, your graph flows entirely into virtual nodes (ADRs, modules). That's normal early on but improves as you have more cross-doc references.

## CI integration

The kit ships `.github/workflows/traceability-check.yml`. It:

1. Triggers on PRs touching `docs/prds/**`, `docs/specs/**`, `docs/plans/**`, `.claude/plans/**`, or the script itself.
2. Runs `npm run traceability:check` on the changed files only.
3. Regenerates the matrix and fails if the committed `docs/traceability-matrix.md` is stale.

The "stale matrix" check is the unglamorous but important bit — it forces contributors to regenerate the matrix when they add a new tracked doc.

### Local pre-commit hook (optional)

```bash
# .husky/pre-commit
changed=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.md$' || true)
if [ -n "$changed" ]; then
  node scripts/traceability.js check $changed
fi
```

Fails the commit locally before CI does.

## Reading the graph: worked example

Say you get this graph on a regenerated matrix:

```
PRD-2026-0005 → REQ-2026-0042
PRD-2026-0005 → module/billing
SPEC-2026-0008 → PRD-2026-0005
SPEC-2026-0008 → ADR-0011
PLAN-2026-Q3 → SPEC-2026-0008
```

What it tells you:

- `REQ-2026-0042` drove `PRD-2026-0005`. If the requirement card changes scope, the PRD needs review.
- `PRD-2026-0005` touches `module/billing`. Any billing-module PR should cross-check against this PRD.
- `ADR-0011` is load-bearing for `SPEC-2026-0008`. Deprecating ADR-0011 has a direct spec dependency.
- `PLAN-2026-Q3` inherits everything above transitively.

Backlinks section for `ADR-0011` would show `SPEC-2026-0008` as the single referrer. Orphans section would flag if `REQ-2026-0042` had no outgoing edges (which it wouldn't — requirement cards are leaves).

## Adding a new doc type

To track a new type like `OBSRV-` (observability doc):

1. Add to `REQUIRED_FIELDS` in `scripts/traceability.js`:
   ```js
   REQUIRED_FIELDS.OBSRV = ["doc_id", "title", "owner", "status", "date"];
   ```
2. Add a matching classDef color in `renderMermaid()` for visual distinction.
3. (If relevant) add a new directory to `SCAN_DIRS`.

Keep it dependency-light: the script uses only `gray-matter`. Resist the urge to pull in parsers or schemas.

## When to regenerate

- After adding / renaming / retiring a tracked doc
- After changing any `related.*` block
- CI regenerates on every PR; you only need to regenerate locally when inspecting

The file is deterministic for a given tree — rebuilds produce byte-identical output when nothing's changed, so `git diff` is empty unless something actually moved.

## Related

- [Concepts: Traceability](../concepts/traceability)
- [Guide: Confluence Sync](./confluence-sync) — the reverse flow from wiki → Git
