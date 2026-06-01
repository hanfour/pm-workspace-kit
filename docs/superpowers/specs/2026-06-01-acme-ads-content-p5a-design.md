# AcmeAds demo content foundation — design (P5a)

**Date:** 2026-06-01
**Status:** Approved (design); implementation pending
**Source:** priorities-plan P5 — 垂直案例 demo bundle ([`apps/docs/docs/plans/2026-05-product-priorities-plan.md`](../../../apps/docs/docs/plans/2026-05-product-priorities-plan.md))

## Context

P5 ships a polished AcmeAds vertical demo: **3 seed PRDs + 5 seed atoms + a Slack walkthrough + a `pmk demo` driver**, so someone can run the full knowledge-loop demo in ~30 minutes. P5 was decomposed during brainstorming into three sub-projects:

- **P5a (this spec)** — the content foundation: the seed atoms + PRDs everything else consumes.
- **P5b** — the `pmk demo` driver (seed workspace + push guided messages).
- **P5c** — the walkthrough doc + record.

**This spec covers only P5a.** The existing AcmeAds example (`examples/acme-ads/`, authored 2026-04-27) is a *docs-kit* example (1 PRD, 1 ADR, 1 module playbook, 1 CRM ontology) demonstrating front-matter + traceability — it has **no gateway knowledge atoms**. M4 (v0.16) shipped `pmk gateway demo seed`, but that is **one generic** smoke-test atom, not AcmeAds-themed. P5a fills the gap: a coherent set of AcmeAds-themed seed atoms + two more PRDs, grounded in the existing CRM-migration / self-service-onboarding narrative.

## Goals

- Five AcmeAds-themed knowledge atoms, loadable into the PKB, that exercise the breadth of the knowledge loop (BIZ translation, a formula, a domain process, a finance distinction, a code-grounded question).
- Two more AcmeAds PRDs that extend the existing narrative and pass traceability.
- A clean, tagged, idempotent seed/unseed API the future `pmk demo` (P5b) can call.

## Non-goals

- **No `pmk demo` command** (P5b) — P5a delivers the `seedAcmeAdsAtoms()` function only.
- **No walkthrough script / record** (P5c).
- **No change to M4's `pmk gateway demo seed`** — that stays the minimal generic smoke test; the AcmeAds bundle is separate and separately tagged.

## Format decision

- **5 atoms → a TS seed module** `packages/cli/src/gateway/acme-ads-seed.ts` (sibling of the existing `demo-seed.ts`, same directory — no new `gateway/demo/` namespace). The five atoms are defined as `KnowledgeAtom` data and written via the existing `saveAtom()` (which owns the on-disk gray-matter markdown format, scope sanitisation, and the `status` default). This guarantees format correctness — hand-authoring five markdown front-matters risks drift from the loader's schema — and mirrors the existing `demo-seed.ts` pattern. The future `pmk demo` (P5b) imports and calls the seed function.
  - Tag: every atom carries `ACME_ADS_SEED_TAG = "acme-ads-demo"` in `tags`, distinct from M4's `"demo-seed"`, so unseed targets exactly this bundle.
  - Status: `"approved"` so retrieval surfaces them immediately in a demo.
  - `source.contributorUserId` / `source.threadKey`: synthetic demo values (e.g. `"acme-ads-demo"`), clearly not a real Slack user/thread.
  - **Retrieval-scope note (constrains P5b):** the atoms land under `~/.pmk/knowledge/acme-ads/`. The gateway's default `searchAtoms(text, { limit: 3 })` is **unscoped** (searches all scopes), so the demo works as-is today. P5b must therefore either keep the demo's atom search unscoped, or explicitly set the demo's retrieval scope to `acme-ads` — if a future change scopes retrieval by repo/domain, these atoms would silently disappear from the demo. Carried into P5b's spec; called out here so the scope choice is deliberate.
- **2 PRDs → markdown** under `examples/acme-ads/docs/prds/` (pure docs, no schema risk), matching the existing `2026-Q2-customer-onboarding-prd.md` (PRD-2026-0001).

## Content

### Five atoms (scope `acme-ads`, ad-tech / CRM-migration narrative)

Each atom is `{ question, answer, summary, tags: [..., ACME_ADS_SEED_TAG], scope: "acme-ads", status: "approved", source: {synthetic} }`. Answers are concise, BIZ-readable, and grounded in the fictional AcmeAds domain (consistent with the CRM ontology + onboarding PRD already in the example).

1. **AdFormat vs placement** — what's the difference? (BIZ-translation atom; uses 「廣告版型」/「版位」.)
2. **vCPM of a placement** — how is it computed, and where does the data live? (formula + data-source atom.)
3. **Customer data migration after self-service onboarding** — how do legacy customers get migrated once self-service onboarding ships? (ties to PRD-2026-0001 + the `crm-customer-migration` module.)
4. **PlacementRevenue vs AccountPayable** — what's the difference, and which one shows on the P&L? (finance-distinction atom; the v0.13.3 anchor terms.)
5. **Onboarding dedup rule location** — which module holds the customer-dedup rule for onboarding? (code-grounded atom — the kind of question the gateway would `mra-ask` / escalate; references the module playbook.)

### Two PRDs (extend the narrative; traceability-valid)

Both use real front-matter (`doc_id`, `title`, `owner`, `status`, `date`, `related: { requirement, adr, module, ... }`) like PRD-2026-0001, with `doc_id` continuing the sequence:

- **PRD-2026-0002 — Ad placement performance dashboard** (vCPM / PlacementRevenue reporting). Ties to atoms 2 and 4.
- **PRD-2026-0003 — Customer data dedup for onboarding.** Ties to atom 5 and the existing onboarding PRD (PRD-2026-0001).

`related` links must point at ids that exist within the example (the existing `ADR-0004`, `crm.customer` module) or are declared virtual, so the example stays internally consistent.

## Seed/unseed API (`acme-ads-seed.ts`)

- `ACME_ADS_SEED_TAG = "acme-ads-demo"`.
- `ACME_ADS_ATOMS: readonly AcmeAdsAtomSeed[]` — the five atoms' authored content (question / answer / summary / tags / scope).
- `seedAcmeAdsAtoms(): { atomIds: string[]; alreadyPresent: boolean }` — writes the five atoms via `saveAtom` if not already present (idempotent: re-running does not duplicate; detect by `ACME_ADS_SEED_TAG` + question match). Returns the ids.
- `unseedAcmeAdsAtoms(): { removedIds: string[] }` — removes exactly the atoms tagged `ACME_ADS_SEED_TAG`, leaving all other atoms (including M4's `demo-seed`) untouched.

Mirror `demo-seed.ts`'s structure and idempotency contract.

## File map

| Path | Change |
|---|---|
| `packages/cli/src/gateway/acme-ads-seed.ts` (new) | the 5 atoms' content + `seedAcmeAdsAtoms` / `unseedAcmeAdsAtoms` + `ACME_ADS_SEED_TAG` |
| `examples/acme-ads/docs/prds/2026-Q2-placement-dashboard-prd.md` (new) | PRD-2026-0002 |
| `examples/acme-ads/docs/prds/2026-Q2-onboarding-dedup-prd.md` (new) | PRD-2026-0003 |
| `examples/acme-ads/README.md` (modify) | list the two new PRDs + a one-line note that gateway seed atoms live in the CLI seed module; **fix the stale "`--cwd` … coming in a future release" line** — `--cwd` ships today, so document the real command `node packages/core/src/traceability.js check --cwd=examples/acme-ads` |
| `packages/cli/test/acme-ads-seed.test.ts` (new) | seed / unseed / idempotency tests |

## Correctness / edge cases

- **Idempotent seed:** a second `seedAcmeAdsAtoms()` writes nothing new (detect existing by tag + question); no duplicate atoms accumulate.
- **Targeted unseed:** `unseedAcmeAdsAtoms()` removes only `acme-ads-demo`-tagged atoms; a co-existing M4 `demo-seed` atom and any real atoms survive.
- **Tag isolation:** `ACME_ADS_SEED_TAG !== DEMO_SEED_TAG`.
- **PRD ids are unique** within the example (continue the PRD-2026-000N sequence; don't collide with PRD-2026-0001).
- Tests isolate `~/.pmk` via a tmp `HOME` (the established `node:test` pattern).

## Testing

- `seedAcmeAdsAtoms` writes exactly 5 atoms, all `status: "approved"`, all tagged `acme-ads-demo`, scope `acme-ads`; returns 5 ids.
- Re-running `seedAcmeAdsAtoms` is a no-op (still 5 atoms, `alreadyPresent: true`).
- `unseedAcmeAdsAtoms` after seed removes all 5; an unrelated atom written via `saveAtom` (different tag) is untouched.
- `loadAtoms({ scope: "acme-ads" })` returns the 5 seeded atoms.
- PRD docs: the two new PRD files parse (front-matter present) and traceability over the example passes — run `node packages/core/src/traceability.js check --cwd=examples/acme-ads` (the `--cwd` flag ships today) and confirm no errors. The repo's `npm run traceability:check` still targets `apps/docs` only, so the example is checked via the explicit `--cwd` invocation, not the default CI gate.

## Out of scope / future (P5b, P5c)

- `pmk demo` driver that seeds + pushes a guided message sequence (P5b).
- The 30-minute walkthrough doc + text/video record (P5c).
- Wiring the `examples/` tree into the **default CI** `traceability:check` (it targets `apps/docs`; the example is checkable today via the explicit `--cwd=examples/acme-ads` invocation, but adding it to the CI gate is a separate concern).
