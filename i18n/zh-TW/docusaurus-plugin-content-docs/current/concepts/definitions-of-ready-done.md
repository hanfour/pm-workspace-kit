---
sidebar_position: 2
---

# Definition of Ready / Done

每個文件類型有兩條品質線：動筆前（**DoR**）、被當依據執行前（**DoD**）。兩者由 review 強制，不由 script — kit 只提供每個類型一個放 checklist 的地方。

## 為什麼不用 policy wiki

Wiki 政策死在抽屜裡。貼近文件的 checklist 會出現在每次 review，給 reviewer 一個具體問題問，不只是「看起來 OK 嗎」。

## 標準規格

### 需求卡（REQ-\*）

**Ready to intake**：
- [ ] 背景 / 痛點 / 受影響角色齊全
- [ ] 問題陳述明確
- [ ] 優先級粗估（Must / Should / Nice）

**Done（卡可交給 PM）**：
- [ ] 對齊 Ontology 的影響分析
- [ ] 複雜度估 S / M / L / XL
- [ ] 指派 PM owner
- [ ] `doc_id` 發出

### PRD（PRD-\*）

**Ready to write**：
- [ ] 來源需求卡已 Approved
- [ ] Ontology 查詢完成
- [ ] 無重複 PRD
- [ ] 利害關係人 + 決策者名單確定

**Done**：
- [ ] `doc_id`、`related.requirement`、`related.module` 填齊
- [ ] 每個 Must/Should/Could/Won't 有可測驗收標準
- [ ] 每個 KPI 是 SMART
- [ ] 假設與風險列並標緩解策略
- [ ] 3 位 reviewer 簽核（通常：PM Lead / Architect / lead engineer）
- [ ] Status Draft → In Review 或 Approved

### Spec（SPEC-\*）

**Ready to write**：
- [ ] 對應 PRD 已 Approved
- [ ] 技術 owner 確認
- [ ] 上游 API / 模組依賴已盤點
- [ ] 相關 ADR 檢視

**Done**：
- [ ] `doc_id`、`related.prd`、`related.module` 填齊
- [ ] API 契約含錯誤碼與範例
- [ ] 資料模型對齊 Ontology
- [ ] 測試策略涵蓋單元 / 整合 / 效能
- [ ] Deploy + rollback 可執行
- [ ] Architect + 一位資深工程師簽核

### Plan（PLAN-\*）

**Ready**：負責人有足夠 context 與授權承諾團隊。

**Done**：
- [ ] 里程碑有日期或明確「待 X 決定」
- [ ] 依賴關係明確（需要什麼、解鎖什麼）
- [ ] 回退或中止條件寫下來

## 如何改寫這些規格

你會有本 kit 未涵蓋的類型（決策文件、RFC、ops runbook）。在相應 skill / template 末端加 checklist，反向連回本頁。

不要把每個 checkbox 塞進每個團隊 policy。挑你團隊 review 最常失敗的 4 條，強制它們。

## kit 怎麼用這些

本 kit 的 Claude Code PM skills 把 checklist 內嵌在生成文件裡。跑 `/create-prd` 的 reviewer 得到內建 DoR/DoD 的文件。

不用 Claude Code 也可以 — 把 checklist 貼到 PR template 或文件本身即可。目標是「reviewer 要有意識簽過」不是自動化。

## 相關

- [概念：追溯性](./traceability.md)
- [指南：Handoff to Implementation](../guides/handoff-to-implementation.md)
