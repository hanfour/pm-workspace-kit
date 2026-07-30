---
sidebar_position: 3
---

# PRD Front-matter Template

Drop this block at the top of every new PRD. Replace placeholders. The `traceability:check` script validates required fields.

```yaml
---
doc_id: PRD-YYYY-NNNN
title: <short human title>
owner: "@<github-handle>"
status: Draft          # Draft | In Review | Approved | Deprecated
date: YYYY-MM-DD
related:
  requirement: []      # REQ-YYYY-NNNN — the source requirement card
  plan: []             # upstream plans
  spec: []             # downstream specs (filled as they're written)
  architecture: []     # architecture chapters touched
  adr: []              # ADRs driving this PRD
  module: []           # domain module ids, e.g. billing.invoice
  confluence_page_id: null   # auto-written by publish-to-confluence skill
---
```

## Per-field rules

| Field | Required? | Notes |
|---|---|---|
| `doc_id` | Yes | Must match pattern `PRD-YYYY-NNNN` |
| `title` | Yes | Short, human. Not the filename. |
| `owner` | Yes | GitHub handle, quoted to survive YAML parser |
| `status` | Yes | One of the four values; empty strings fail the check |
| `date` | Yes | ISO 8601 |
| `related.requirement` | Yes (validated) | Can be empty array `[]` for greenfield |
| `related.*` (others) | No | Include the keys as empty arrays for completeness |

## Status state machine

```
Draft → In Review → Approved
           ↓          ↓
        Draft     Deprecated
```

- `Draft`: author is writing. No reviewer expected yet.
- `In Review`: ready for stakeholder review. Reviewers comment and approve in Confluence (or PR).
- `Approved`: decision made. Downstream work (specs, plans) can begin.
- `Deprecated`: no longer the source of truth. Cross-link to successor via `related.prd`.

## Example

```yaml
---
doc_id: PRD-2026-0015
title: Customer self-service invoice download
owner: "@alice"
status: In Review
date: 2026-05-12
related:
  requirement: [REQ-2026-0080]
  plan: []
  spec: [SPEC-2026-0020]
  architecture: []
  adr: [ADR-0008]
  module: [billing.invoice, billing.portal]
  confluence_page_id: "123456789"
---
```

## Related

- [Concepts: Traceability](../concepts/traceability) — full schema explanation
- [Concepts: DoR / DoD](../concepts/definitions-of-ready-done) — when a PRD is ready to write vs ship
