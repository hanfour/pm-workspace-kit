# AcmeAds demo walkthrough — design (P5c)

**Date:** 2026-06-01
**Status:** Approved (design); implementation pending
**Source:** priorities-plan P5 — 垂直案例 demo bundle. Final P5 piece, building on P5a (seed atoms) + P5b (`pmk demo`).

## Context

P5's *Signal of done* includes "走查紀錄（文字或影片擇一）". P5a authored the 5 AcmeAds seed atoms; P5b shipped `pmk demo seed/unseed/run`. **P5c (this spec)** is the human-facing **walkthrough document** that ties them together: a 30-minute guided demo of the full knowledge loop, using the AcmeAds bundle, with a real Q&A transcript as the record. It is **distinct from `gateway/onboarding.md`** — that doc is the *install* 30-minutes (manifest → tokens → config → doctor → seed + dry-run → go-live); this doc is the *experience-the-value* walkthrough you run *after* install.

## Goals

- One doc that gets an already-installed operator from "bot is running" to "I've watched the full PKB → grounded-answer → escalation-boundary loop on the AcmeAds example" in ~10–15 min of active steps.
- Lead with the **zero-extra-credential** path (manually DM the bot the guided questions and watch it answer) so anyone with a running gateway can do it; document `pmk demo run` as the automated option.
- Embed a Q&A transcript (the **fictional AcmeAds** questions + representative grounded answers) as the walkthrough record — no real-host PKB data on the public page.

## Non-goals

- **No video** — text transcript record only.
- **No changes to `onboarding.md`** beyond adding a cross-link. (`acme-ads.md` gets one targeted fix — see Placement — because P5c makes its stale section more visible.)
- **No new code** — P5c is documentation; the demo machinery is P5a/P5b (already merged).
- **No new `pmk demo` features.**

## Placement

New doc `apps/docs/docs/examples/acme-ads-demo.md` (sibling of `acme-ads.md`, `sidebar_position: 2`). Docusaurus-built, so it needs valid front-matter and must not introduce broken links / fail the docs build. Add `"examples/acme-ads-demo"` to the `examples` items in `apps/docs/sidebars.ts` (after `"examples/acme-ads"`).

**Also fix the sibling `apps/docs/docs/examples/acme-ads.md`** "Running the example" section (lines ~62-70): it still says to edit `SCAN_DIRS` and that `--cwd` is "a future kit version" — but `--cwd` ships today (P5a fixed the *repo-root* `examples/acme-ads/README.md`, but **not** this Docusaurus page; they are different files). Replace that stale block with the real commands `node packages/core/src/traceability.js check --cwd=examples/acme-ads` (and `… matrix --cwd=examples/acme-ads`). Cross-linking it from the new page makes the staleness more visible, so fix it now.

## Outline

1. **What this is** — after install, experience the full loop (PKB retrieval → grounded BIZ answer → escalation boundary) on the AcmeAds fictional ad-tech workspace; ~10–15 min.
2. **Prerequisites** — gateway installed per the [onboarding guide](../gateway/onboarding.md) and running (`pmk gateway status` → running); your own Slack user account in the workspace (to DM the bot).
3. **Seed the demo knowledge** — `pmk gateway demo seed` *(note: M4's generic smoke atom)* **and** `pmk demo seed` (the 5 AcmeAds atoms, P5a). Clarify which seeds the AcmeAds set (`pmk demo seed`).
4. **Run the loop (manual path — no extra credentials, the default)** — DM the pmk bot the five guided questions one at a time and watch it answer:
   1. AcmeAds 的 AdFormat 跟 placement 有什麼差別？
   2. 某個 placement 的 vCPM 怎麼算？資料在哪看？
   3. self-service onboarding 上線後，舊客戶的資料怎麼遷？
   4. PlacementRevenue 跟 AccountPayable 差在哪？財報上看哪個？
   5. customer onboarding 的客戶去重規則寫在哪個 module 的哪個函式？
5. **Run the loop (automated path — optional)** — `pmk demo run --channel <id>` posts the same five questions as you and prints the transcript; note it needs a one-time Slack **user OAuth token** (`PMK_DEMO_USER_TOKEN`, `xoxp-…`) with only **`chat:write`** (the token is used solely for `auth.test` + `chat.postMessage` — `demo.ts`), because the gateway ignores bot-posted messages so a real user identity must do the posting. **Reply-reading uses the gateway *bot* token's `conversations.replies`** (the channel access you already configured during onboarding) — so the **user token does NOT need any history scope**. Keep the user token's grant minimal. If `pmk demo run` can post but can't read replies, troubleshoot the **bot** side (is the bot in the channel? `pmk gateway doctor`; the bot's `im:history` / `channels:history` scopes), not the user token. Point at `pmk demo run --dry-run` to preview.
6. **What you should see (the record)** — the expected transcript: each question with a representative grounded answer (sourced from the seeded atoms). Annotate what each demonstrates:
   - Q1/Q4 → BIZ-tier translation (廣告版型 / 版位; 收入端 vs 應付).
   - Q2 → a formula + data source grounded in the PKB.
   - Q3 → ties to the AcmeAds onboarding PRD + migration module.
   - Q5 → the **escalation boundary**: the PKB answers to the module level; "which function" is where the bot would `mra-ask` / escalate to a human. **Expected outcome on a default install:** with no escalation contact configured (the out-of-box state), the gateway surfaces a **config-hint** instead of @-mentioning a human (and saves no pending marker) — `escalation.ts` posts a config-hint when the pool is empty. The doc must say this explicitly so a reader doesn't think the demo failed when Q5 tags no one; note that `pmk gateway escalation add …` is what turns Q5 into a real human @-mention.
   Answers are LLM-phrased so exact wording varies; they stay grounded in the seeded atoms. **Use only the fictional AcmeAds answers** (representative text derived from the 5 P5a atoms) — do **not** embed any real-host PKB answer (e.g. real department budget figures); a public Docusaurus page must not carry real internal ops data. A general line that the loop has been exercised end-to-end on a live host is fine; concrete real answers are not.
7. **Clean up** — `pmk demo unseed` removes the 5 AcmeAds atoms (and `pmk gateway demo unseed` the smoke atom) so the demo leaves no residue.
8. **Related** — cross-link `gateway/onboarding.md`, `examples/acme-ads.md` (the docs-kit view of the same company), `gateway/lifecycle.md`.

## Path decision (decided: A)

The walkthrough **leads with the manual path** (§4): seed, then DM the five questions yourself and watch real replies — achievable with only the bot install everyone already has, zero extra credentials. `pmk demo run` (§5) is presented as the automated/scripted option for operators who set up a user token. Rationale: the walkthrough's value is *seeing the bot answer well*; manual posting reaches that with no friction, while `pmk demo run` adds the (one-time) xoxp setup.

## Correctness / docs hygiene

- Front-matter: `sidebar_position: 2` (match `acme-ads.md`'s style — front-matter only, no traceability `doc_id` needed for an examples narrative).
- Internal links use Docusaurus-resolvable relative paths (`../gateway/onboarding.md`, `./acme-ads.md`); do **not** link `_briefs/`-style underscore dirs as markdown links (per the project's `_briefs` link trap).
- Verify `npm --workspace apps/docs run build` exits 0 and introduces **no new** broken links beyond the pre-existing site-wide `LICENSE.txt` footer + zh-TW relative-link warnings.
- Sidebar entry added so the page is reachable.

## Testing / verification

- `npm --workspace apps/docs run build` → exit 0; grep the build log to confirm no new broken-link target is introduced by this page (only the known pre-existing `LICENSE.txt` / zh-TW noise).
- Manual: the documented commands (`pmk demo seed` / `unseed`, `pmk gateway status`) match the shipped CLI surface (P5a/P5b); the 5 questions match `ACME_ADS_DEMO_SCRIPT`.

## Out of scope / future

- Video walkthrough.
- Wiring the doc into any automated link-check beyond the existing docs build.
- Any change to the `pmk demo` command behaviour.
