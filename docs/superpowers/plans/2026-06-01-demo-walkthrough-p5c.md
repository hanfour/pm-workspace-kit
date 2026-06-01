# AcmeAds Demo Walkthrough Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 30-minute "watch the knowledge loop" demo walkthrough doc for the AcmeAds bundle, lead with the zero-credential manual path, and fix the now-stale traceability note on the sibling `acme-ads.md` docs page.

**Architecture:** Pure documentation. One new Docusaurus page `apps/docs/docs/examples/acme-ads-demo.md` (sidebar_position 2) + a sidebar entry; plus a targeted stale-fix to `apps/docs/docs/examples/acme-ads.md`. Verification is the docs build (exit 0, no new broken links).

**Tech Stack:** Markdown / Docusaurus. Spec: `docs/superpowers/specs/2026-06-01-demo-walkthrough-p5c-design.md`. Consumes P5a (`pmk demo seed`, 5 atoms) + P5b (`pmk demo run`).

---

## File Structure

| Path | Change |
|---|---|
| `apps/docs/docs/examples/acme-ads-demo.md` (new) | the walkthrough |
| `apps/docs/sidebars.ts` (modify) | add `"examples/acme-ads-demo"` to the `examples` items |
| `apps/docs/docs/examples/acme-ads.md` (modify) | replace the stale "Running the example" `--cwd`-is-future block |

> No TDD — this is docs. Verification = `npm --workspace apps/docs run build` exits 0 with no NEW broken link (only the pre-existing site-wide `LICENSE.txt` footer + zh-TW relative-link warnings are acceptable). Content is checked against the shipped CLI (`pmk demo` / `ACME_ADS_DEMO_SCRIPT`).

---

## Task 1: The walkthrough page + sidebar entry

**Files:**
- Create: `apps/docs/docs/examples/acme-ads-demo.md`
- Modify: `apps/docs/sidebars.ts`

- [ ] **Step 1: Create the walkthrough doc**

Create `apps/docs/docs/examples/acme-ads-demo.md` with EXACTLY this content:

````markdown
---
sidebar_position: 2
---

# AcmeAds demo: watch the knowledge loop

Once your gateway is installed and running, this ~10–15 minute walkthrough lets you *watch* the full knowledge loop work — PKB retrieval → a grounded, BIZ-readable answer → the escalation boundary — using the fictional **AcmeAds** ad-tech workspace. It's the companion to the install guide: [Gateway onboarding](../gateway/onboarding.md) gets the bot running; this gets you to "I've seen it answer."

> AcmeAds is a fictional ad-tech company (see the [docs-kit example](./acme-ads.md)). All names, metrics, and data here are invented.

## Prerequisites

- The gateway is installed per [Gateway onboarding](../gateway/onboarding.md) and **running** — confirm with `pmk gateway status` (should show `running: yes`).
- Your own Slack account is in the workspace, so you can DM the bot.

## 1. Seed the AcmeAds knowledge (1 min)

```bash
pmk demo seed
```

Writes five approved AcmeAds knowledge atoms (ad placements, vCPM, customer migration, finance terms, an onboarding dedup rule) into the local PKB, tagged `acme-ads-demo`. Re-running is idempotent. (This is distinct from `pmk gateway demo seed`, which writes a single generic smoke-test atom.)

## 2. Ask the bot — the guided five (manual path, no extra setup)

DM the **pmk** bot these five questions, one at a time, waiting for each answer. This needs nothing beyond the running gateway — you are the user, so the bot answers normally.

1. `AcmeAds 的 AdFormat 跟 placement 有什麼差別？`
2. `某個 placement 的 vCPM 怎麼算？資料在哪看？`
3. `self-service onboarding 上線後，舊客戶的資料怎麼遷？`
4. `PlacementRevenue 跟 AccountPayable 差在哪？財報上看哪個？`
5. `customer onboarding 的客戶去重規則寫在哪個 module 的哪個函式？`

## 3. What you should see

The bot answers in BIZ-friendly 繁中, grounded in the seeded atoms. Exact wording varies (the model phrases each answer), but the substance tracks the PKB:

| # | Question | The answer should contain | Demonstrates |
|---|---|---|---|
| 1 | AdFormat vs placement | AdFormat = 廣告版型（規格／計價單位）；placement = 版位（放在哪）；一對多 | **BIZ translation** — jargon in plain terms |
| 2 | vCPM | `PlacementRevenue ÷ 可視曝光 × 1000`；資料在 `placement_daily` 的 `revenue` / `viewable_impressions`；≠ CPM | **Formula + data source** from the PKB |
| 3 | Customer migration | 舊客戶不自動進 self-service；依 onboarding PRD + `crm-customer-migration` module 分批可回滾遷移 | **Ties to the docs-kit example** |
| 4 | PlacementRevenue vs AccountPayable | 收入端 vs 支出端應付；P&L top line vs 資產負債表 | **BIZ finance distinction** |
| 5 | Dedup rule location | 規則定義在 `PRD-2026-0003`、模組邊界在 `crm.customer`；確切函式位置「要問 IT」 | **The escalation boundary** |

**On question 5 — what "escalate" looks like out of the box.** The bot answers to the module boundary and, if it judges the "which function" part needs a human, it will *try* to escalate. On a **fresh install with no escalation contact configured**, the gateway posts a **config hint** (a message telling you to set up an escalation contact) instead of @-mentioning anyone, and saves no pending marker. That is expected, not a failure. To make question 5 tag a real person, configure a contact first:

```bash
pmk gateway escalation add default <slack-user-id>
```

## 4. Automated path (optional) — `pmk demo run`

To post the same five questions automatically and print a transcript:

```bash
pmk demo run --channel <channel-or-dm-id> --dry-run   # preview first
pmk demo run --channel <channel-or-dm-id>             # then for real
```

`run` posts **as you** (so the bot answers), reads each reply, and prints a Q→A transcript. It needs a one-time Slack **user OAuth token** in `PMK_DEMO_USER_TOKEN` (`xoxp-…`) with only **`chat:write`** — the token is used solely to post the questions. Reply-reading uses your already-configured gateway **bot** token, so the user token needs **no history scope**; keep its grant minimal. If `run` can post but can't read replies, check the **bot** side (is it in the channel? `pmk gateway doctor`), not the user token.

## 5. Clean up

```bash
pmk demo unseed     # removes the 5 AcmeAds atoms (tag acme-ads-demo)
```

(`pmk gateway demo unseed` removes the separate generic smoke atom, if you seeded it.) The demo leaves no residue in your PKB.

## Related

- [Gateway onboarding](../gateway/onboarding.md) — install the gateway (the 30-minute setup)
- [Example: AcmeAds](./acme-ads.md) — the same fictional company from the docs-kit (PRDs / ADR / traceability) angle
- [Gateway lifecycle](../gateway/lifecycle.md) — how the knowledge loop works under the hood
````

- [ ] **Step 2: Add the sidebar entry**

In `apps/docs/sidebars.ts`, find the `examples` category items (currently `items: ["examples/acme-ads"]`) and change it to:

```ts
      items: ["examples/acme-ads", "examples/acme-ads-demo"],
```

- [ ] **Step 3: Build the docs and verify no new broken link**

Run (from repo root):
```bash
npm --workspace apps/docs run build > /tmp/p5c-build.log 2>&1; echo "exit=$?"
grep -E "linking to" /tmp/p5c-build.log | grep -viE "LICENSE" | sed -E 's/.*linking to /-> /' | sort -u
```
Expected: `exit=0`. The broken-link `->` list shows only the pre-existing zh-TW relative-`.md` targets (e.g. `../changelog.md`, `./lifecycle.md`) — **none** pointing at `acme-ads-demo` or the links this page introduces (`../gateway/onboarding.md`, `./acme-ads.md`, `../gateway/lifecycle.md` all resolve). If a new broken target appears for this page's links, fix the relative path and rebuild.

- [ ] **Step 4: Commit**

```bash
git add apps/docs/docs/examples/acme-ads-demo.md apps/docs/sidebars.ts
git commit -m "docs(examples): AcmeAds demo walkthrough — watch the knowledge loop (P5c)"
```

---

## Task 2: Fix the stale traceability note on `acme-ads.md`

**Files:**
- Modify: `apps/docs/docs/examples/acme-ads.md`

- [ ] **Step 1: Replace the stale "Running the example" block**

In `apps/docs/docs/examples/acme-ads.md`, the "Running the example" section currently reads (around lines 62-70):

````markdown
## Running the example

```bash
cd examples/acme-ads
# The top-level script scans the kit's docs by default.
# To run it against the example, temporarily adjust SCAN_DIRS in scripts/traceability.js.
```

A future kit version will take a `--cwd` flag so you can point the scripts at any sub-repo without editing them.
````

Replace that whole section body with:

````markdown
## Running the example

`--cwd` ships today — check or regenerate this example's traceability directly:

```bash
node packages/core/src/traceability.js check --cwd=examples/acme-ads
node packages/core/src/traceability.js matrix --cwd=examples/acme-ads
```

The repo's `npm run traceability:check` targets `apps/docs`; use the explicit `--cwd` above for this example.
````

(Match the surrounding heading style; replace only this section, leave the rest of `acme-ads.md` unchanged.)

- [ ] **Step 2: Build the docs and verify**

Run (from repo root):
```bash
npm --workspace apps/docs run build > /tmp/p5c-build2.log 2>&1; echo "exit=$?"
grep -ci "could not be resolved\|broken" /tmp/p5c-build2.log
```
Expected: `exit=0`. The new fenced code block introduces no links, so no new broken-link targets.

- [ ] **Step 3: Commit**

```bash
git add apps/docs/docs/examples/acme-ads.md
git commit -m "docs(examples): fix stale --cwd traceability note on acme-ads page (P5c)"
```

---

## Task 3: Final docs build + content sanity

- [ ] **Step 1: Full docs build**

Run: `npm --workspace apps/docs run build`
Expected: exit 0; only pre-existing `LICENSE.txt` + zh-TW relative-link warnings (no new broken target from the new page).

- [ ] **Step 2: Content sanity vs shipped CLI**

Confirm the doc's commands and questions match what shipped:
```bash
grep -c "ACME_ADS_DEMO_SCRIPT\|seedAcmeAdsAtoms" packages/cli/src/gateway/acme-ads-seed.ts packages/cli/src/gateway/demo/acme-ads-script.ts
grep -n "demo \[subcommand\]\|--channel\|--dry-run" packages/cli/src/index.ts
```
Expected: the 5 questions in the doc match `ACME_ADS_DEMO_SCRIPT`; `pmk demo` with `--channel`/`--dry-run` is registered. (Spot-check, not an automated assert.)

- [ ] **Step 3: Commit any fixups** (only if Steps 1–2 surfaced a mismatch)

```bash
git add -A && git commit -m "docs(examples): align walkthrough with shipped demo CLI"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** new `examples/acme-ads-demo.md` + sidebar → Task 1; manual path leads, `pmk demo run` optional with **chat:write-only** user token + bot-side reply-read note → Task 1 §4; Q5 escalation config-hint expectation on a default install → Task 1 §3; transcript record uses **only fictional AcmeAds** answers (no real-host ops data) → Task 1 §3 table; clean-up + cross-links → Task 1 §5/Related; `acme-ads.md` stale `--cwd` fix → Task 2; docs-build hygiene → Tasks 1/3. All covered.
- **Placeholder scan:** the full doc content is inline; no "TBD". The escalation config-hint is described generically (no fabricated exact UI string); the `pmk gateway escalation add default <slack-user-id>` form matches the shipped positional command.
- **Consistency:** the 5 questions are verbatim `ACME_ADS_DEMO_SCRIPT`; `pmk demo seed/unseed/run --channel --dry-run` matches P5b; `PMK_DEMO_USER_TOKEN` `chat:write`-only matches the corrected spec + the implementation (user token only posts; bot token reads).

## Out of scope (future)

Video walkthrough; any change to `pmk demo` behaviour; the P5b internal spec's same stale scope line (optional follow-up on main).
