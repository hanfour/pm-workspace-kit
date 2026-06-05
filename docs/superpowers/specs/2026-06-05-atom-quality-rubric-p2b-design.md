# Atom quality rubric + audit playbook (P2b) — design

**Date:** 2026-06-05
**Status:** Approved (design); implementation pending
**Source:** priorities-plan **P2 — Atom 品質控制**. P2a (telemetry instrumentation) shipped in v0.17.0; this is **P2b**, deliberately gated until real signal existed. Path **B** (chosen 2026-06-05): write the rubric/playbook **structure** now; defer the threshold **numbers** to calibration at the first real audit. Telemetry remains demo-only as of 2026-06-05 (after `pmk demo unseed`, the corpus holds organic atoms only), so any number written now is a v0 default, not data-derived.

## Context

The gateway proposes knowledge atoms from conversations; a human approver reacts (👍 approve / edit-then-approve / 👎 reject), with a TTL auto-promote fallback for un-acted proposals. P2a added per-atom telemetry — `reuseCount`, `lastRetrievedAt`, `questionedCount`, `lastQuestionedAt` (`atom-telemetry.ts`) — surfaced by `pmk gateway atoms telemetry` (dead-weight / load-bearing flags). What's missing (P2's remaining signal-of-done): a **documented approver rubric** and a **quarterly audit playbook**. The failure mode is irreversible-ish (low-signal atoms accumulate; the later you clean, the more there is — brief R4), so the quality gate sits primarily **at approval time** (strict), with the audit as the safety net.

## Goals

- A documented, strict-leaning **approver rubric**: precise approve / absorb-with-edit / reject criteria a human can apply consistently at proposal time.
- A repeatable **quarterly audit playbook**: telemetry-driven classification of existing atoms into keep / fix / retire, with concrete steps.
- Usable **now** without faking data: structure is final; threshold numbers are explicit v0 defaults marked for calibration.

## Non-goals (YAGNI)

- No code changes — telemetry instrumentation (P2a) already ships the fields and the `atoms telemetry` command. This is documentation only.
- No automated enforcement of the rubric (it guides a human approver; not a gate in code).
- No change to the reaction-approval mechanism or the TTL auto-promote behaviour in code (the ADR records a *stance*, not a code change).
- No data-derived calibration of thresholds — that happens at the first real audit, by design.

## Decisions

### A. Two artifacts (decided)

1. **`apps/docs/docs/adr/0007-atom-approval-rubric.md`** — an ADR (decision record) for the approval rubric. Follows the existing ADR style (`adr/0001`–`0006`, `templates/adr-template.md`). Next number is 0007.
2. **`apps/docs/docs/guides/atom-audit-playbook.md`** — an operational runbook for the quarterly audit. A guide (recurring process), not a decision record — hence separate from the ADR.

### B. Approval rubric — five axes, strict (ADR-0007)

Applied by the approver when a proposed atom surfaces. **No telemetry exists yet at approval time** (a brand-new atom has never been retrieved), so the rubric is **content-quality**. Default disposition is strict: an atom must clear **all five** axes to approve; failing any routes to absorb-with-edit or reject.

1. **Grounded** — traceable to a verifiable source: a doc / code / ADR / PRD / named system or field, **or a named SME's answer in the captured source thread** (an atom distilled from a named IT/domain expert's Slack reply is grounded — don't mistake a legitimate human answer for an unsourced assertion). Only genuinely unsourced claims fail this axis.
2. **Durable** — a stable fact likely to be asked again, not a one-off / time-bound / ephemeral answer.
3. **Correctly scoped** — right scope tag, filed where that scope's audience would look.
4. **Non-duplicate** — not already covered by an approved atom; overlapping content should be merged, not duplicated.
5. **Self-contained** — answerable on its own, no dangling "depends on the thread above" context.

**Trichotomy mapping:**
- **Approve (👍):** clears all five.
- **Absorb-with-edit:** good core but fails **scope / non-duplicate / self-contained** (the *fixable* axes) → edit (re-scope, merge, or tighten) then approve.
- **Reject (👎):** fails **grounded** or **durable** (the *unfixable-by-edit* axes), or is a pure duplicate adding nothing new.

Each axis gets a one-line "what good looks like" + a failing example in the ADR.

### C. TTL auto-promote stance (decided: keep + audit safety-net)

Strict gating and TTL auto-promote are in tension (auto-promote approves without the rubric). The ADR records the decision: **keep auto-promote as a fallback for un-acted proposals; the quarterly audit is what catches whatever auto-promote let through.** It also *notes* (without committing this window) that high-stakes scopes could later lengthen or disable auto-promote — flagged as a future tuning lever, not part of P2b. No code change.

### D. Quarterly audit playbook (guides/atom-audit-playbook.md)

Telemetry-driven review of **existing** atoms, run quarterly by the host/approver via `pmk gateway atoms telemetry`. The four signals below are **review flags, not a partition** — an atom can trip more than one (e.g. dead-weight AND stale), and most healthy atoms (recent, low-but-nonzero reuse, no questions) trip **none**. So the playbook applies a **precedence** (first match wins for the headline action) and counts the rest separately:

**Precedence:** Questioned → Dead-weight → Stale → Load-bearing → **Unflagged (keep, counted separately)**.

| Review flag | Signal | Action |
|---|---|---|
| **Questioned** | `questionedCount` over the §E threshold | review the atom + its source → fix (re-ground/edit) or retire (highest precedence — a grounding problem outranks low usage) |
| **Dead-weight** | `reuseCount` 0 after the maturity window | retire candidate — remove unless there's a known reason to keep |
| **Stale** | `lastRetrievedAt` old + low reuse | review for relevance → keep / edit / retire |
| **Load-bearing** | high `reuseCount`, `questionedCount` 0 | keep; the corpus backbone — do not churn |
| **Unflagged** | none of the above (recent, nonzero reuse, no questions) | keep, no action; counted in the audit-log total |

The playbook documents: who runs it, the quarterly cadence, the exact command, the precedence application, and recording each run as a short **audit-log entry** (date, count per flag + unflagged total, what was retired/fixed) so successive audits show the trend.

### E. Path-B deferred calibration

The **structure** (B + D) is final. The **numbers** are explicit **v0 defaults** carrying a `⚖️ calibrate` marker + a one-line rationale, to be re-set at the first real audit once organic telemetry exists:

| Number | v0 default | Why this default (to calibrate) |
|---|---|---|
| Dead-weight maturity window | one quarter (~90 days) | long enough that a genuinely useful atom would have been retrieved at least once across a quarter's traffic |
| Questioned threshold | `questionedCount ≥ 2` **or** (`reuseCount ≥ 5` **and** `questionedCount / reuseCount ≥ 0.3`) | a single 👎 is noise, so the ratio arm needs a **reuse floor** — without it a 1/1 atom trips immediately, contradicting "one 👎 is noise". The floor reuses the CLI's existing `LOAD_BEARING_MIN_REUSE = 5` (`gateway.ts`) so the rubric and the tool agree on "enough usage to judge" |
| Stale window | `lastRetrievedAt` older than two quarters with low reuse | half a year unused is a strong relevance signal |

The first quarterly audit explicitly includes a step: "review whether these v0 thresholds match observed reality; adjust and record."

## Correctness / docs hygiene

- ADR **section structure** follows `templates/adr-template.md` (Status / Date / Deciders / Tags / Context / Decision / Consequences / Alternatives / References); **metadata mirrors ADR-0006** (`doc_id`/`title`/`owner`/`status`/`date` front-matter) since the template's code block omits YAML front-matter but the recent ADRs carry it — match the recent ones, not the bare template.
- **Index:** the ADR index is [`adr/README.md`](apps/docs/docs/adr/README.md) (its "How to add an ADR" step 3 says *add a row*), **not** `adr/0003`. The index table currently lists only ADR-0001–0003 and is **stale** — it omits the existing 0004/0005/0006. Backfill rows for **0004 (desktop-framework), 0005 (pmk-mra-bridge), 0006 (pmk-gateway-slack)** and then add **0007**, so the index is correct and complete.
- The playbook references `pmk gateway atoms telemetry` exactly as shipped (P2a) and the four telemetry fields by their real names.
- Docusaurus build must stay green (no new broken links beyond the pre-existing site-wide `LICENSE.txt` footer); both docs use Docusaurus-resolvable relative links and avoid `_briefs/`-style underscore-dir markdown links.
- Cross-link: ADR-0007 ↔ the playbook; both ↔ the P2 plan section and the telemetry concept.

## Testing / verification

- `npm --workspace apps/docs run build` → exit 0, no new broken-link target from the two new pages.
- Content sanity: the rubric's three outcomes map cleanly (no atom can be simultaneously "approve" and "reject"); the playbook's four review flags each have a defined action, the **precedence** resolves multi-flag atoms to one headline action, and **unflagged** atoms are explicitly kept + counted (so the flags need not partition); every deferred number carries the `⚖️ calibrate` marker, and the questioned-ratio arm has its reuse floor.

## Out of scope / future

- Data-derived threshold calibration (first real audit).
- Any automated/code enforcement of the rubric or the audit.
- Auto-promote TTL changes for high-stakes scopes (noted as a lever, not built).
- Telemetry-as-ranking-input and a `gateway audit` summary line (P2a's deferred items, still future).
