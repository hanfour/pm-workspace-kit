# Product Priorities — 2026-05 → 2026-06

- Date: 2026-05-26
- Status: Draft (priorities under review)
- Owner: Hanfour Huang
- Related brief: `apps/docs/docs/_briefs/2026-05-product-narrative-brief.md` (repo-only; not published in Docusaurus)

## 範圍與切分原則

這份計畫服務於 brief 裡固定下來的主敘事：
**PMK = traceable PM docs + Slack knowledge loop for code-aware teams**。

五個優先序，按 leverage 排。每個項目有：outcome、signal of done、下一個
要產出的 artifact。其他想法放最後的 "Out of scope" 段。

## P1 — Gateway onboarding（最大槓桿）

**Outcome**：一台乾淨的機器上，host 可以在 30 分鐘內把 Gateway 拉起來，
不用讀 source code。

**Signal of done**

- Slack app manifest 進倉（one-click install，不再手寫 scopes）。
- `pmk gateway doctor` 涵蓋：Slack tokens、Anthropic key、mra workspace
  存在、PKB seed sanity、channel ACL。
- Dry-run 模式：能跑完 atom retrieval + LLM + escalation 路徑，但不發
  訊息到 Slack。
- **Smoke-test demo only**：1 channel + 1 seed atom，足以讓新 host 驗證
  迴路能跑完。Polished AcmeAds demo bundle（多份 seed PRD、多顆 atom、
  走查腳本）留給 P5，不要在 P1 做。

**Next artifact**：`apps/docs/docs/prds/2026-05-gateway-onboarding-prd.md`
（待撰寫）。

**為什麼擺第一**：brief 中 R2（host onboarding 仍重）是阻擋「一般 PM
自行導入」的最大門檻；做完才有資格談 adoption metrics。

## P2 — Atom 品質控制

**Outcome**：PKB 規模上升後，approved atom 維持高 signal；低 signal 的
atom 可被看見、可被清掉。

**Signal of done**

- Approver rubric 文件化：何時 approve、何時 absorb-with-edit、何時 reject。
- Atom telemetry 欄位：reuse-count、last-retrieved-at、
  was-questioned-after-citation。
- Quarterly atom audit playbook：哪些 atom 是死重、哪些是 load-bearing。

**Next artifact**：approval rubric 的 ADR + telemetry schema 變更。

**為什麼擺第二**：brief R4。這條失敗模式不可逆，越晚做、要清的 atom 越多。
但要等 P1 第一輪有真實 onboarding 流量，rubric 才不會憑空寫。

## P3 — 對外訊息切分（base vs. mra-enhanced）

**Outcome**：讀 `intro.md` 與 README 的人，60 秒內分得出哪些 feature
要靠 mra、哪些不用。

**Signal of done**

- `intro.md` 改寫，明確分 *base value* 與 *mra-enhanced value* 兩段。
- README 採用路徑改成 brief 裡 Day 1 / Day 2 / Week 1 / Week 2 的順序。
- Desktop 在 `intro.md` 與 README 中從 co-equal surface 降為 secondary。

**Next artifact**：對 `intro.md` 與 `README.md` 的 doc PR。

**為什麼可與 P1 並行**：純文件改動，不依賴 Gateway 程式改動。

## P4 — 採用成功的計量

**Outcome**：能用數字、而不是感覺，回答「有人在用嗎」。

**Signal of done**

- Time-to-first-PRD（Day 1 outcome）。
- 每週 Gateway answered-question 數。
- mra-ask success rate（LLM 自答 vs. escalation）。
- Escalation-to-atom conversion rate。
- Atom retrieval reuse rate。

**Next artifact**：instrumentation plan，放在 `apps/docs/docs/plans/`。

**為什麼擺第四**：要等 P2 把 atom telemetry 加上去之後才能量得到。

## P5 — 垂直案例 demo bundle

**Outcome**：有人能在 30 分鐘內跑完一個完整迴路的 demo。

**Signal of done**

- AcmeAds example 擴成：3 份 seed PRD + 5 顆 seed atom + Slack 走查
  腳本。
- `pmk demo`（或一支 script）：seed example workspace + 推一連串
  guided message。
- 走查紀錄（文字或影片擇一）。

**Next artifact**：demo 腳本 + seed data，放 `apps/docs/docs/examples/`。

## 不在這個視窗的事情

- **Desktop 補齊到 PRD parity**：明確延後。Gateway onboarding 出貨後再評。
- **Hybrid / embedding retrieval**：現行 BM25 還夠用，等 atom 數量造成
  precision 抱怨再啟動。
- **Hosted / SaaS 變體**：明確不做，與 gateway PRD 的 host-run 模型衝突。

## 排程

```
週 1     週 2     週 3     週 4     週 5     週 6
[----- P1 -----]
[----- P3 -----]
            [---- P2 ----]
                       [-- P4 --]
                                [---- P5 ----]
```

- P1 與 P3 並行起跑（一個是產品、一個是文件）。
- P2 等 P1 第一輪可用後再啟動，rubric 才有真實數據可參照。
- P4 在 P2 telemetry 落地之後啟動，沒有 instrumentation 量不到東西。
- P5 最後，因為它要消費 P1 + P2 + P3 的成果。

## 驗收這份計畫的方式

四週後回看：

1. 一個新 host 是否能照 P1 的 doctor + manifest 在 30 分鐘內裝起來？
2. P2 的 rubric 是否擋下了至少一顆低 signal 的 atom？
3. `intro.md` 是否已分 base / mra-enhanced 兩段？
4. 是否量得到 escalation-to-atom 的轉換率？
5. AcmeAds demo 是否能 30 分鐘內被外部人跑完？

如果第 1 題否，整份計畫順序就要重排。
