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

### A recorded run

An actual manual walkthrough on a live gateway, grounded in the seeded atoms. Wording varies per run; the substance tracks the PKB. (Question 5's answer is lightly redacted — the live reply named the host's own loaded repos; here it shows the generic boundary it demonstrates.)

**Q1 — AcmeAds 的 AdFormat 跟 placement 有什麼差別？**
> AdFormat 是「長什麼樣」，placement 是「放在哪」。AdFormat（廣告版型）定義廣告的呈現規格——橫幅、原生、影音、插頁——決定素材尺寸、互動元件與計價單位。placement（版位）是這個版型實際投放的位置——某 App 首頁頂部、文章列表第三則、影片前貼。一對多關係：同一個 AdFormat 可投到多個 placement，同一個 placement 也可能支援多種 AdFormat。報表以 placement 為最小計量單位，AdFormat 用來分群分析。

**Q2 — 某個 placement 的 vCPM 怎麼算？資料在哪看？**
> vCPM = 該 placement 的 PlacementRevenue ÷ 可視曝光數 × 1000。資料來源是報表系統的 `placement_daily` 日彙總表，欄位是 `revenue`（分子）和 `viewable_impressions`（分母）。注意 vCPM 和 CPM 不同——CPM 用總曝光，vCPM 只算有進入可視區的曝光，廣告主結算通常看 vCPM。

**Q3 — self-service onboarding 上線後，舊客戶的資料怎麼遷？**
> 舊客戶不會自動進 self-service 流程，對他們來說上線是無感的。依 PRD-2026-0001 與 `crm-customer-migration` module 的設計，遷移是分批、可回滾的 Strangler Fig 方式：(1) 既有客戶資料維持在舊 CRM 表，self-service 只接新註冊；(2) 背景 job 按 batch 把舊客戶 profile 對映到新 schema；(3) 每批遷移後跑對帳，異常的留在舊表、不阻擋新流程。ADR-0004 有記錄這個決策的脈絡。

**Q4 — PlacementRevenue 跟 AccountPayable 差在哪？財報上看哪個？**
> 兩個是不同方向的錢，不可互換。PlacementRevenue 是 AcmeAds 從廣告主那邊「收進來」的版位營收，計入損益表（P&L）的營收 top line，看「賺多少」用這個。AccountPayable 是 AcmeAds 要「付出去」的——主要是付給 media/publisher 的分潤與供應商應付帳款，落在資產負債表的負債端，看「欠多少待付」用這個。財報上：PlacementRevenue → 損益表；AccountPayable → 資產負債表。

**Q5 — customer onboarding 的客戶去重規則寫在哪個 module 的哪個函式？**
> Module 邊界已知：`crm.customer`，比對主鍵是 normalized email + 公司統編，命中合併、衝突取最近一次 self-service 提交。但「確切是哪個函式」需要深入 `acme-ads` repo——該 repo 未載入此 PKB，所以 bot 答到 module 邊界為止；更深的位置就是 **escalation 邊界**（交給 IT，或先把該 repo 載入 workspace）。

Notice Q5: the bot answers precisely to the boundary it can ground (the module), then stops — "which exact function" is the hand-off. That hand-off *is* the escalation boundary in action.

## 4. Automated path (optional) — `pmk demo run`

`pmk demo run` posts the five questions for you and prints a Q→A transcript. One real limitation is worth knowing before you reach for it:

- **`--dm` (auto-open the bot DM) does NOT drive the bot** when `PMK_DEMO_USER_TOKEN` is the **gateway app's own** user token. Slack does not redeliver a message posted with an app's user token back to that same app's bot as a `message.im` event (loop prevention), so the bot never sees the questions and every turn prints `(no reply)`. A **manually typed** DM (section 2) is unaffected — it isn't posted through the app's token. This is why the manual path is the recommended walkthrough.
- **The channel path works**, because an @-mention is delivered through the separate `app_mention` event:

  ```bash
  pmk demo run --channel <channel-id> --dry-run   # preview first
  pmk demo run --channel <channel-id>             # then for real
  ```

  Reply-reading then needs the **bot** to hold `channels:history` for that channel (DMs use `im:history`, which the bot already has). Without it, `run` prints `(could not read replies: missing_scope)` — the posting and the bot answering still happened (confirm via the events log / `pmk gateway atoms telemetry`); only the transcript read-back failed.

The token (`PMK_DEMO_USER_TOKEN`, `xoxp-…`) needs only **`chat:write`**. For a frictionless walkthrough, prefer the **manual path (section 2)** — no token, no extra scope.

## 5. Clean up

```bash
pmk demo unseed     # removes the 5 AcmeAds atoms (tag acme-ads-demo)
```

(`pmk gateway demo unseed` removes the separate generic smoke atom, if you seeded it.) The demo leaves no residue in your PKB.

## Related

- [Gateway onboarding](../gateway/onboarding.md) — install the gateway (the 30-minute setup)
- [Example: AcmeAds](./acme-ads.md) — the same fictional company from the docs-kit (PRDs / ADR / traceability) angle
- [Gateway lifecycle](../gateway/lifecycle.md) — how the knowledge loop works under the hood
