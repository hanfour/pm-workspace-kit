# Atom quality rubric + audit playbook (P2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship P2b — a documented strict approver rubric (ADR-0007) and a quarterly telemetry-driven audit playbook — with structure final and threshold numbers marked for later calibration.

**Architecture:** Pure documentation. Two new Docusaurus pages (`adr/0007-atom-approval-rubric.md`, `guides/atom-audit-playbook.md`) + a sidebar entry for the guide + a backfilled ADR index (`adr/README.md`). No code. Verification is the docs build (exit 0, no new broken links) + content cross-checks against the shipped telemetry.

**Tech Stack:** Markdown / Docusaurus. Spec: `docs/superpowers/specs/2026-06-05-atom-quality-rubric-p2b-design.md`.

---

## File Structure

| Path | Change |
|---|---|
| `apps/docs/docs/adr/0007-atom-approval-rubric.md` (new) | the approval rubric ADR (project ADR; not in sidebar, reachable via the index — matches 0004–0006) |
| `apps/docs/docs/guides/atom-audit-playbook.md` (new) | the quarterly audit runbook (a guide; added to the sidebar Guides category) |
| `apps/docs/sidebars.ts` (modify) | add `"guides/atom-audit-playbook"` to the Guides category |
| `apps/docs/docs/adr/README.md` (modify) | add a "Project ADRs" table with rows for 0004, 0005, 0006 (currently missing) + 0007 |

> No TDD — this is docs. Verification = `npm --workspace apps/docs run build` exits 0 with no NEW broken link (only the pre-existing site-wide `LICENSE.txt` footer is acceptable). Content is cross-checked: cross-links resolve; every deferred number carries `⚖️ calibrate`; the rubric/playbook thresholds match the spec.

Context the engineer needs:
- ADR section structure follows `apps/docs/docs/templates/adr-template.md` (Status / Date / Deciders / Tags / Context / Decision / Consequences / Alternatives / References). Metadata front-matter mirrors **ADR-0006** (`doc_id` / `title` / `owner` / `status` / `date` / `related`), since recent ADRs carry it even though the bare template omits YAML.
- The telemetry fields are exactly `reuseCount`, `lastRetrievedAt`, `questionedCount`, `lastQuestionedAt` (`packages/cli/src/gateway/atom-telemetry.ts`), surfaced by `pmk gateway atoms telemetry`. `LOAD_BEARING_MIN_REUSE = 5` lives in `packages/cli/src/commands/gateway.ts`.

---

## Task 1: ADR-0007 — the approval rubric

**Files:**
- Create: `apps/docs/docs/adr/0007-atom-approval-rubric.md`

- [ ] **Step 1: Create the ADR** with EXACTLY this content:

````markdown
---
doc_id: ADR-2026-0007
title: Atom approval rubric — strict five-axis gate at proposal time
owner: "@hanfour"
status: Accepted
date: 2026-06-05
related:
  prd: []
  module:
    - packages.cli
  confluence_page_id: null
---

# ADR-0007: Atom approval rubric — strict five-axis gate at proposal time

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** @hanfour
- **Tags:** gateway, knowledge, pkb, process

## Context

The gateway proposes knowledge atoms from conversations; a human approver reacts (👍 approve / edit-then-approve / 👎 reject), with a TTL auto-promote fallback for un-acted proposals. As the PKB grows, accumulating low-signal atoms is an effectively irreversible failure mode — the later you clean, the more there is (priorities-plan brief R4). v0.17.0 (P2a) added per-atom telemetry (`reuseCount`, `lastRetrievedAt`, `questionedCount`, `lastQuestionedAt`), but telemetry only describes an atom *after* it has been retrieved — it cannot inform the *initial* approval. So the primary quality gate must sit at approval time, applied consistently. This ADR documents that rubric. The recurring telemetry-driven cleanup of existing atoms lives in the separate [atom audit playbook](../guides/atom-audit-playbook.md).

## Decision

Approve a proposed atom only when it clears **all five** content-quality axes; otherwise absorb-with-edit or reject. The default disposition is **strict** — low-signal atoms do not enter the corpus on the assumption the audit will clean them later.

The five axes (the approver asks each):

1. **Grounded** — traceable to a verifiable source: a doc / code / ADR / PRD / named system or field, **or a named SME's answer in the captured source thread**. A distilled answer from a named IT/domain expert is grounded — only genuinely unsourced claims fail.
2. **Durable** — a stable fact likely to be asked again, not a one-off / time-bound / ephemeral answer.
3. **Correctly scoped** — right scope tag, filed where that scope's audience would look.
4. **Non-duplicate** — not already covered by an approved atom; overlapping content is merged, not duplicated.
5. **Self-contained** — answerable on its own, with no dangling "depends on the thread above" context.

Outcome mapping:

- **Approve (👍):** clears all five.
- **Absorb-with-edit:** good core but fails one of the *fixable* axes — **correctly-scoped / non-duplicate / self-contained** → edit (re-scope, merge, or tighten), then approve.
- **Reject (👎):** fails **grounded** or **durable** (the axes an edit can't fix), or is a pure duplicate adding nothing new.

**TTL auto-promote stance:** keep auto-promote as a fallback for un-acted proposals; the quarterly audit catches whatever it promotes without the rubric. High-stakes scopes could later lengthen or disable the auto-promote TTL — a future tuning lever, not decided here.

## Consequences

### Positive
- The corpus stays high-signal: low-signal atoms are stopped at the door, not after they've diluted retrieval.
- A consistent, teachable checklist makes approver decisions repeatable across people and time.
- Pairs with the audit playbook: the rubric prevents; the audit cleans up auto-promote leakage.

### Negative
- A strict gate rejects some borderline-useful atoms; genuine knowledge can be lost to an over-zealous approver (mitigated: the source thread stays searchable and the atom can be re-proposed).
- More approver effort per proposal than a lenient "approve unless obviously bad" stance.
- The rubric is human-applied, not enforced in code — consistency depends on the approver following it.

### Neutral
- Auto-promote remains a leak path by design; the audit absorbs that. Tightening it is deferred.

## Alternatives Considered

### Alternative A: Lenient approval + rely on the quarterly audit to clean dead weight
- **Pros:** less approver effort; leans on the P2a telemetry already built.
- **Cons:** low-signal atoms exist and dilute retrieval for up to a quarter before cleanup; the irreversible-accumulation failure mode is exactly what brief R4 warns against.
- **Rejected because:** the failure mode's cost grows with delay — preventing is cheaper than periodically cleaning.

### Alternative B: Tiered strictness by scope/source
- **Pros:** could relax the gate for low-risk auto-extracted atoms.
- **Cons:** more rubric complexity; harder to apply consistently.
- **Rejected because:** YAGNI for now — a single strict rubric is simpler; revisit if a scope clearly warrants different handling.

## References

- priorities-plan P2 — `apps/docs/docs/plans/2026-05-product-priorities-plan.md`
- [Atom audit playbook](../guides/atom-audit-playbook.md) — the cleanup side of P2
- Atom telemetry (P2a, v0.17.0): `packages/cli/src/gateway/atom-telemetry.ts`, `pmk gateway atoms telemetry`
````

- [ ] **Step 2: Commit**

```bash
cd /Users/hanfourhuang/pm-workspace-kit
git add apps/docs/docs/adr/0007-atom-approval-rubric.md
git commit -m "docs(adr): ADR-0007 atom approval rubric — strict five-axis gate (P2b)"
```

---

## Task 2: The quarterly audit playbook + sidebar entry

**Files:**
- Create: `apps/docs/docs/guides/atom-audit-playbook.md`
- Modify: `apps/docs/sidebars.ts`

- [ ] **Step 1: Create the playbook** with EXACTLY this content:

````markdown
---
sidebar_position: 5
---

# Atom audit playbook (quarterly)

A recurring, telemetry-driven review of the **existing** approved atoms, to keep the PKB high-signal as it grows. It is the safety net to [ADR-0007](../adr/0007-atom-approval-rubric.md)'s approval gate: the rubric prevents low-signal atoms at the door; this audit catches what slipped through (notably via TTL auto-promote) and retires what has gone stale.

## When + who

- **Cadence:** quarterly.
- **Who:** the gateway host / atom approver.
- **Input:** `pmk gateway atoms telemetry` — joins the approved corpus with the per-atom telemetry sidecar (`reuseCount`, `lastRetrievedAt`, `questionedCount`, `lastQuestionedAt`) and flags dead-weight / load-bearing.

## The four review flags

These are **review flags, not a partition** — an atom can trip more than one, and most healthy atoms (recent, low-but-nonzero reuse, no questions) trip none. Apply this **precedence** for the headline action (first match wins) and count the rest:

**Questioned → Dead-weight → Stale → Load-bearing → Unflagged (keep).**

| Flag | Signal | Action |
|---|---|---|
| **Questioned** | `questionedCount` meets the threshold (below) | review the atom + its source → fix (re-ground/edit) or retire. Highest precedence: a grounding problem outranks low usage. |
| **Dead-weight** | `reuseCount` is 0 after the maturity window | retire candidate — remove unless there is a known reason to keep. |
| **Stale** | `lastRetrievedAt` is old + reuse is low | review for relevance → keep / edit / retire. |
| **Load-bearing** | high `reuseCount`, `questionedCount` 0 | keep; the corpus backbone — do not churn. |
| **Unflagged** | none of the above | keep, no action; counted in the run total. |

## Thresholds (v0 — calibrate against real data)

Conservative starting values, **not** data-derived. The first audit with real organic telemetry should re-check and adjust them.

- **Dead-weight maturity window:** ⚖️ calibrate: one quarter (~90 days). Long enough that a genuinely useful atom would have been retrieved at least once across a quarter's traffic.
- **Questioned threshold:** ⚖️ calibrate: `questionedCount ≥ 2` **or** (`reuseCount ≥ 5` **and** `questionedCount / reuseCount ≥ 0.3`). A single 👎 is noise, so the ratio arm needs a reuse floor; the `5` matches the CLI's `LOAD_BEARING_MIN_REUSE`.
- **Stale window:** ⚖️ calibrate: `lastRetrievedAt` older than two quarters with low reuse. Half a year unused is a strong relevance signal.

## Steps

1. Run `pmk gateway atoms telemetry` (add `--json` to script the triage).
2. For each atom, apply the precedence above to get one headline flag + action.
3. Action the flags: retire dead-weight (and confirmed-bad questioned) atoms; fix (re-ground/edit) recoverable questioned atoms; leave load-bearing + unflagged alone.
4. **Recalibrate:** check whether the v0 thresholds above match what you observed; adjust and note the change.
5. **Record an audit-log entry** (below).

## Audit log

Keep a short entry per run so successive audits show the trend:

```
## <YYYY-Qn> atom audit (<date>)
- total atoms: <N>   (unflagged kept: <N>)
- questioned: <N> → fixed <N>, retired <N>
- dead-weight: <N> → retired <N>
- stale: <N> → kept <N>, edited <N>, retired <N>
- load-bearing: <N>
- threshold changes: <none | describe>
```

## Related

- [ADR-0007: Atom approval rubric](../adr/0007-atom-approval-rubric.md) — the prevention side.
- Atom telemetry (P2a): `pmk gateway atoms telemetry`.
- priorities-plan P2 — `apps/docs/docs/plans/2026-05-product-priorities-plan.md`.
````

- [ ] **Step 2: Add the guide to the sidebar**

In `apps/docs/sidebars.ts`, find the **Guides** category `items` array (it contains `"guides/traceability-matrix"`, `"guides/confluence-sync"`, `"guides/authoring-north-star"`, `"guides/handoff-to-implementation"`) and append `"guides/atom-audit-playbook"`:

```ts
        "guides/traceability-matrix",
        "guides/confluence-sync",
        "guides/authoring-north-star",
        "guides/handoff-to-implementation",
        "guides/atom-audit-playbook",
```

- [ ] **Step 3: Commit**

```bash
cd /Users/hanfourhuang/pm-workspace-kit
git add apps/docs/docs/guides/atom-audit-playbook.md apps/docs/sidebars.ts
git commit -m "docs(guides): quarterly atom audit playbook + sidebar entry (P2b)"
```

---

## Task 3: Backfill + extend the ADR index

**Files:**
- Modify: `apps/docs/docs/adr/README.md`

- [ ] **Step 1: Add a "Project ADRs" section.** The README's existing table is introduced as the three pre-written **methodology** ADRs (0001–0003) — leave it as is. The kit's own decisions (0004–0006) are currently **missing from any index**; add them plus 0007 in a new section. Insert this block immediately **after** the existing methodology ADR table (the one ending with the ADR-0003 row), before the `## How to use` heading:

```markdown
## Project ADRs

The kit's own architectural + process decisions (write your own starting at 0004+):

| # | Title | Status | Date |
|---|---|---|---|
| [ADR-0004](./0004-desktop-framework.md) | Desktop app framework — Electron | Accepted | 2026-04-24 |
| [ADR-0005](./0005-pmk-mra-bridge.md) | pmk delegates code intelligence to mra (does not absorb) | Accepted | 2026-04-27 |
| [ADR-0006](./0006-pmk-gateway-slack.md) | pmk gateway — host-machine bot for Slack/LINE, not SaaS | Accepted | 2026-04-27 |
| [ADR-0007](./0007-atom-approval-rubric.md) | Atom approval rubric — strict five-axis gate at proposal time | Accepted | 2026-06-05 |
```

- [ ] **Step 2: Commit**

```bash
cd /Users/hanfourhuang/pm-workspace-kit
git add apps/docs/docs/adr/README.md
git commit -m "docs(adr): backfill ADR index with 0004–0006 + add 0007 (P2b)"
```

---

## Task 4: Docs build green + content cross-check

- [ ] **Step 1: Build the docs**

Run (from repo root):
```bash
npm --workspace apps/docs run build > /tmp/p2b-build.log 2>&1; echo "exit=$?"
grep -E "linking to|broken" /tmp/p2b-build.log | grep -viE "LICENSE" | sed -E 's/.*linking to /-> /' | sort -u
```
Expected: `exit=0`. The broken-link list shows only the pre-existing site-wide `LICENSE.txt` footer (and any pre-existing zh-TW relative-link noise) — **none** pointing at `0007-atom-approval-rubric`, `atom-audit-playbook`, or the cross-links between them (`../guides/atom-audit-playbook.md`, `../adr/0007-atom-approval-rubric.md`, and the README's `./0004…`–`./0007…`). If a new broken target appears for these, fix the relative path and rebuild.

- [ ] **Step 2: Content cross-check (manual, against the spec)**

Confirm:
```bash
grep -c "⚖️ calibrate:" apps/docs/docs/guides/atom-audit-playbook.md   # expect 3
grep -c "LOAD_BEARING_MIN_REUSE\|reuseCount ≥ 5" apps/docs/docs/guides/atom-audit-playbook.md  # questioned floor present
grep -n "0007-atom-approval-rubric\|atom-audit-playbook" apps/docs/docs/adr/0007-atom-approval-rubric.md apps/docs/docs/guides/atom-audit-playbook.md  # cross-links both ways
```
Expected: 3 `⚖️ calibrate:` markers; the questioned reuse-floor present; ADR-0007 links to the playbook and the playbook links to ADR-0007. The five rubric axes + the four review flags + precedence match the spec (`docs/superpowers/specs/2026-06-05-atom-quality-rubric-p2b-design.md`).

- [ ] **Step 3: Commit any fixups** (only if Steps 1–2 surfaced a mismatch)

```bash
cd /Users/hanfourhuang/pm-workspace-kit
git add -A && git commit -m "docs: P2b cross-link / build fixups"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** ADR-0007 (5 axes + trichotomy + TTL stance) → Task 1; audit playbook (review flags + precedence + unflagged + v0 thresholds with ⚖️ markers + audit log) → Task 2; ADR index backfill 0004–0006 + 0007 → Task 3; docs-build + cross-link verification → Task 4. Spec sections A–E all map to a task.
- **Placeholder scan:** the `⚖️ calibrate:` thresholds are deliberate v0 defaults (concrete values + rationale), not TBDs; the audit-log `<…>` are template fields the operator fills per run (intended), not plan gaps. No "TODO"/"fill in later".
- **Consistency:** the questioned threshold (`≥ 2` or `reuse ≥ 5 ∧ ratio ≥ 0.3`), the five axes wording (incl. SME-source grounding), the four flags + precedence, and the ADR metadata convention (mirror ADR-0006) are identical across the ADR, the playbook, and the spec. ADR filename `0007-atom-approval-rubric.md` is referenced identically in the playbook, the README index, and the build check.

## Out of scope (future)

Data-derived calibration (first real audit); any code enforcement of the rubric/audit; auto-promote TTL changes for high-stakes scopes; telemetry-as-ranking-input.
