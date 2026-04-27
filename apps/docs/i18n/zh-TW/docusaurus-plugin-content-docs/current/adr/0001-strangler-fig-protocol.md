---
sidebar_position: 2
---

# ADR-0001: Strangler Fig 遷移協議

- **Status:** Accepted
- **Date:** 2026-04-24
- **Deciders:** Architect、PM Lead、Engineering Lead
- **Tags:** migration, methodology

## Context

任何大型 monolith 遷到新系統都跨多季。即興作業的團隊會得到：
- 跨模組對帳標準不一
- 壞時沒明確 rollback 路徑
- 「Stage 2 多長？」各模組答案不同
- Stakeholder 驚訝（「不是已經上線了？」）

共享協議 + 命名階段 + 量化退出標準解決這四點。

## Decision

採用四階段 **Strangler Fig** 協議（narrative 見 [概念：Strangler Fig](../concepts/strangler-fig.md)）。每個模組遷移用相同階段名、對帳門檻、rollback playbook。逐模組 override 在該模組 playbook 明確標註。

### 四階段

1. **Stage 0 — Prep**：新系統 schema + service + 對帳工具就緒，無流量。Feature flag `migration.<module>.mode = off`
2. **Stage 1 — Shadow Read**：讀流量仍由舊；新系統並發查詢；diff 記 log。退出：< 0.1% diff × 7 天
3. **Stage 2 — Double Write**：寫雙寫；逐小時對帳。退出：< 0.01% diff × 14 天
4. **Stage 3 — Cutover**：流量切新、舊反向同步保熱、< 5 min rollback。退出：KPI 持平 × 14 天
5. **Stage 4 — Retire**：舊凍結、表唯讀、30 天觀察（金融：跨一次月結；稅法：7 年保留）

### 逐模組 override

- **金融 / 受監管**：對帳容忍度緊 10 倍（< 0.001%）；所有寫 HITL 強制；Stage 4 等完整週期
- **高量低關鍵**：Stage 1 若 diff 從 day 1 為零可縮至 3 天；Stage 2 若上游冪等可跳

## Consequences

### Positive
- 跨模組共享詞彙；on-call 與 review 可重用
- Rollback 逐階段演練、不在事故中即興
- Stakeholder 能用 stage % 看進度
- 對帳 job 成為可重用 pattern

### Negative
- 雙寫窗內寫 throughput 降 10–20%
- 遷移期間每模組基建成本增 ~30–50%
- Stage 3 反向同步複雜度真實存在

### Neutral
- 有些模組 6 週完成、有些 16 週。這是 OK 的
- 舊程式不可在固定日曆刪 — retire 看業務週期

## Alternatives Considered

### Alternative A: Shadow read → big-bang cutover
- Pros：簡單；無雙寫複雜
- Cons：寫路徑到 cutover 才驗證；交易密集模組風險高
- Rejected：金融模組無法承擔 cutover 風險

### Alternative B: DB 層 CDC（如 Debezium）
- Pros：app 不改
- Cons：只管資料；無法驗業務規則正確性
- Rejected：遷移本身就要改業務邏輯、CDC 不夠

### Alternative C: 無協議 — 逐團隊即興
- Pros：最高彈性
- Cons：就是此 ADR 要解的失敗模式
- Rejected

## References

- Martin Fowler, ["StranglerFigApplication"](https://martinfowler.com/bliki/StranglerFigApplication.html)
- [概念：Strangler Fig](../concepts/strangler-fig.md)
- [Templates: 模組 Playbook](../templates/module-playbook-template.md)
