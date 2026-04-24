---
sidebar_position: 2
---

# Getting Started

A 10-minute walkthrough: clone, install, write your first traceable PRD, watch the validation script fail on purpose, then fix it.

## Prerequisites

- Node.js 18 or newer
- Git
- A markdown editor

## 1. Clone and install

```bash
git clone https://github.com/hanfour/pm-workspace-kit.git my-workspace
cd my-workspace
npm install
```

## 2. Start the docs site (optional)

```bash
npm start
```

The site mounts on `http://localhost:3000/pm-workspace-kit/`. Useful for browsing templates and concepts locally.

## 3. Drop in your first tracked doc

Create `docs/prds/2026-Q3-example.md`:

```markdown
---
doc_id: PRD-2026-0001
title: Example feature
owner: "@your-github-handle"
status: Draft
date: 2026-04-24
related:
  requirement: []
  plan: []
  spec: []
  architecture: []
  adr: []
  module: []
  confluence_page_id: null
---

# Example feature

...your PRD body...
```

:::note
The front-matter keys (`doc_id`, `title`, `owner`, `status`, `date`, `related`) are the **required** schema. `related.requirement` is required for PRD-\*, `related.prd` is required for SPEC-\*, etc. See [Concepts: Traceability](./concepts/traceability.md) for the full validation matrix.
:::

## 4. Run the validator

```bash
npm run traceability:check
```

Output:

```
Traceability check: 1/1 passed
```

Try deleting the `owner` line and re-running — the check will fail with:

```
FAIL  docs/prds/2026-Q3-example.md
      - missing field: owner

Traceability check: 0/1 passed
```

That's the point: malformed docs can't slip through CI.

## 5. Generate the graph

```bash
npm run traceability:matrix
```

Opens (or creates) `docs/traceability-matrix.md`:

- **Section 1**: summary counts
- **Section 2**: flat table of every tracked doc
- **Section 3**: Mermaid dependency graph (rendered in GitHub / Docusaurus / VS Code preview)
- **Section 4**: reverse lookup — who references this ADR / module / architecture chapter
- **Section 5**: orphans — docs that cite nothing, docs no-one cites

Check this file into Git. The [traceability-check workflow](https://github.com/hanfour/pm-workspace-kit/blob/main/.github/workflows/traceability-check.yml) regenerates it on every PR and fails if the committed version is stale.

## 6. Write your first ADR

```bash
cp docs/templates/adr-template.md docs/adr/0001-your-decision.md
```

Edit the copy: title, Context, Decision, Consequences (positive / negative / neutral), Alternatives Considered. Link to it from the PRD via `related.adr: [ADR-0001]` — next time you regenerate the matrix, the ADR becomes a node with an incoming edge.

## 7. Wire Confluence sync (optional)

If your team publishes PRDs to Confluence, see the [Confluence Sync guide](./guides/confluence-sync.md) — reviewer comments and approval-status labels flow back into your markdown automatically every 30 minutes.

## What next

- [Concepts: DoR / DoD](./concepts/definitions-of-ready-done.md) — when is a PRD ready to be written vs ready to ship
- [Guides: Authoring a North Star](./guides/authoring-north-star.md) — use the 10-chapter template for a full platform migration
- [Handoff overview](./handoff/overview.md) — the five artifacts engineering expects before Sprint 5

## Troubleshooting

**`ajv` or `gray-matter` errors on `npm install`**: make sure you're on Node 18+. Run `node -v`.

**Traceability check fails on an unrelated doc**: the validator scans `docs/prds`, `docs/specs`, `docs/plans`, `docs/requirements`, `docs/handoff`, and `.claude/plans`. If you don't want a directory scanned, edit `SCAN_DIRS` in `scripts/traceability.js`.

**Mermaid graph too dense**: once you have 50+ nodes, filter by module or status. Open an issue — the kit will gain a `matrix --module=erp.campaign` mode soon.
