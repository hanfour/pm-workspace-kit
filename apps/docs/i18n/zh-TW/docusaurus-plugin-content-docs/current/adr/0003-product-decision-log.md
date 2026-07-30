---
sidebar_position: 4
---

# ADR-0003: 產品決策記錄（first-class ADR 類別）

- **Status:** Accepted
- **Date:** 2026-04-24
- **Deciders:** PM Lead、Architect
- **Tags:** product, methodology

## Context

團隊通常為技術決策寫 ADR（framework、ORM、infra）。產品面決策 — 定價、entitlement、feature gating、MVP 範圍 — 埋在 PRD appendix、會議記錄、Slack thread。

半年後問題回來：
- 「feature X 為何只在付費 tier？」
- 「為何 v1 不做批次匯入？」
- 「7 天試用的理由？」

答案是「問 Alex、他記得」。Alex 離職機構記憶跟著走。

## Decision

把產品決策當 first-class ADR，與技術 ADR 相同格式、review 流程、status 生命週期。歸檔於 `docs/adr/`，`product` tag、連續編號。

### 何時寫產品 ADR

- 定價（tier、價位、billing 週期）
- Entitlement / feature gating
- MVP 切邊決策（「v1 不做 X」）
- 發佈策略（地區、群組、分階段 rollout）
- 術語 / 命名（尤其對外的）
- 任何會被未來成員挑戰、需理由的決策

### 何時不寫

- 個別 PRD 內容 — 屬 PRD
- 可逆 UX 調整 — PR description
- 戰術 sprint 決策 — sprint review note

### 格式

相同 ADR template（`docs/templates/adr-template.md`）。差在 Deciders：PM Lead 為主決策者、Architect 為 reviewer。Context 常引用市場研究、客戶訪談、定價分析。

## Consequences

### Positive
- 產品決策單一可尋位置
- PRD 透過 `related.adr: [ADR-NNNN]` 交叉引用
- Onboarding 改善：新 PM 可讀 ADR 歷史理解產品形狀
- Deprecation 明確：「過去收 seat，見 ADR-0027；現在收 usage，ADR-0051 繼承」

### Negative
- PM 需學 MADR 格式（一次性成本）
- 初期部分 PM 不買單；習慣要一季
- 短期：部分 PRD 會重複現有 ADR 內容

### Neutral
- 產品與技術 ADR 共用編號；單一 `ADR-NNNN` 序列、tag 不同
- 產品 ADR 可能引用客戶資料；public repo 需 redact / 摘要

## Alternatives Considered

### Alternative A: 產品決策留在 PRD appendix
- Pros：無新工具
- Cons：就是此 ADR 要解的問題
- Rejected

### Alternative B: 獨立 `docs/pdr/`（Product Decision Records）
- Pros：分明
- Cons：重複 template、重複 review、兩個 index
- Rejected：相同格式勝；一個目錄、兩個 tag

### Alternative C: 產品決策用 Confluence / Notion
- Pros：PM 可能更熟工具
- Cons：違反「Git source of truth」；跨工具 drift
- Rejected

## References

- Michael Nygard, "Documenting Architecture Decisions"
- [ADR-0001](./strangler-fig-protocol) — 方法論 ADR pattern
- [概念：ADR 模式](../concepts/adr-patterns)
