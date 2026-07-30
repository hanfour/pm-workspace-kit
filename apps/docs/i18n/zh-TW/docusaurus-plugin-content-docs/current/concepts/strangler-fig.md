---
sidebar_position: 4
---

# Strangler Fig 協議

遷移大型 monolith 到新系統、不做 big-bang 重寫的方法。四個命名階段，每階段量化退出標準。kit 預寫的 **ADR-0001 Strangler Fig Protocol** 是權威版；本頁是概念總覽。

## 四階段

```mermaid
flowchart LR
  P[Stage 0<br/>Prep]
  R[Stage 1<br/>Shadow Read]
  W[Stage 2<br/>Double Write]
  C[Stage 3<br/>Cutover]
  T[Stage 4<br/>Retire]

  P --> R --> W --> C --> T

  R -.diff < 0.1%, 7d.-> W
  W -.recon diff < 0.01%, 14d.-> C
  C -.KPIs steady, 14d.-> T
```

### Stage 0 — Prep（1–2 週）

新程式路徑獨立可跑，尚無流量。

**退出條件**：
- 新系統 schema + migration 就緒
- Domain model + service 層單元測試通過
- 對帳工具可在本機跑
- Feature flag `migration.<module>.mode` 存在、預設 `off`

### Stage 1 — Shadow Read（≥ 7 天）

讀流量仍由舊系統服務。Bridge 把相同查詢並發給新系統、記錄 diff。使用者看不到變化。

**退出條件**：diff 率 < 0.1% 連續 7 天，無 P1 事件歸因於新路徑。

### Stage 2 — Double Write（≥ 14 天）

寫流量雙寫。對帳 job 逐小時比對 row 與衍生 aggregate。差異落 `reconciliation_diffs` 表、超標自動告警。

**退出條件**：diff 率 < 0.01% 連續 14 天，pacing KPI 與聚合值全匹配，金融模組至少完整跑過一次月/季結週期。

### Stage 3 — Cutover（≥ 14 天）

流量切新系統。舊系統仍熱 — 新 → 舊 反向同步，讀命中新。單一 feature flag 切回舊路徑（目標 < 5 分鐘）。

**退出條件**：使用者面 KPI（錯誤率、p95 延遲、功能完整性）相對 baseline 不劣化 14 天；rollback drill 演練過；on-call 交接完成。

### Stage 4 — Retire（1–4 週或更久）

舊程式路徑凍結（PR 拒絕），資料表轉唯讀歸檔。金融 / 受監管模組觀察 30 天、任何刪除之前；稅法適用則保留表 7 年。

## 逐模組例外

預設適用多數模組。兩類常 override：

**金融 / 受監管**：
- 對帳容忍度緊 10 倍（0.001% 而非 0.01%）
- 強制觀察一個週期（月結）才進 Stage 3 → Stage 4
- 所有寫 tool 走 HITL 不看金額

**高量、低關鍵**（如分析擷取）：
- Stage 1 若 diff 從 day 1 為零可縮到 3 天
- Stage 2 若上游冪等且可逆可跳過

override 寫在模組 playbook（`docs/architecture/modules/<module>-migration.md`），不是協議 ADR。

## 模組依賴矩陣

Stage 3 cutover 創造跨模組一致性風險。若模組 A 寫入模組 B（例：campaigns 建立 AR），必須一起切換**或**雙邊 API contract 容忍某側不同版本。

kit 的模組 playbook 模板含 R/W 依賴矩陣。在 Stage 0 填好，讓它驅動 cutover 順序。

## Rollback，非紙上 rollback

每個 stage 轉換有 rollback 程序。每個在真事故前演練過至少一次。

- **Stage 2 → 1**：停雙寫、清對帳隊列。~1 小時
- **Stage 3 → 2**：flag 切回；接受 cutover 窗內寫入只在新側需反向同步。目標 5 分鐘
- **Stage 4 → 3**：最壞情況。舊程式已刪、從 Git 回覆、redeploy。這就是 30 天觀察的原因

## 協議不適用時

- **綠地功能**：無舊系統可 strangle。正常部署即可
- **非資料型遷移**（基建重構、無持久狀態變更）：適配階段但跳過對帳
- **週內遷移**：協議是 overhead。單階段 feature flag + 監控

協議值得當長（多週）+ 有狀態（一致性是風險）的遷移用。否則簡單為好。

## 相關

- ADR-0001 — kit 預寫協議 ADR
- [Templates: 模組 Playbook](../templates/module-playbook-template)
- [Guide: Handoff to Implementation](../guides/handoff-to-implementation)
