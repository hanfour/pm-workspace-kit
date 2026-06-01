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
