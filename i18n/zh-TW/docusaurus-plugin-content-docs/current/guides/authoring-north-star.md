---
sidebar_position: 3
---

# 撰寫北極星架構文件

北極星文件告訴所有人（工程、PM、財務、主管）系統在 12–36 個月後要去哪。長、有主見；kit 提供 10 章骨架讓你不用面對空白頁。

## 何時寫

- 規劃平台遷移（monolith → SOA、Ruby → TS 等）
- 新產品需跨越現任團隊的架構決策
- 現況有「它就是會動」的黑盒子、需要共享地圖

若答案是「為決定一個功能」，那是 PRD 不是北極星。用對工具。

## 10 章結構

| # | 章節 | Owner | 穩定於 |
|---|---|---|---|
| 0 | Executive Summary | PM Lead + Architect | Sprint 0 |
| 1 | As-Is 盤點 | Architect | Sprint 1 |
| 2 | Vision & Principles | PM Lead | Sprint 1 |
| 3 | To-Be 架構 | Architect | Sprint 1 |
| 4 | Pillar I（如資料模型） | Architect | Sprint 2 |
| 5 | Pillar II（如 harness / tooling） | Architect | Sprint 2 |
| 6 | Pillar III（如 AI / platform） | Architect | Sprint 2 |
| 7 | Roadmap（多階段） | PM Lead | Sprint 2 |
| 8 | Migration Strategy | Architect | Sprint 3 |
| 9 | Cross-cutting concerns | Architect | Sprint 3 |
| 10 | ADR Index（指標） | — | 持續演進 |
| Appendix | 詞彙表、術語對照、範例 | 全員 | Sprint 3 / 持續 |

## 撰寫順序：骨架先、散文後

反直覺，散文最後：

1. **Sprint 0（一天）**：寫 Ch.0 至當下可做到的最好。commit。Ch.1–10 只留 sub-heading 骨架。是的，文件看起來尷尬地稀疏。這是重點。
2. **Sprint 1（一到兩週）**：填 Ch.1 / Ch.2 / Ch.3。強制自己用 Mermaid 畫 C4 圖、不要手畫 PNG
3. **Sprint 2**：填 Ch.4–7。這是「如何運作」章節。每支柱各子章節
4. **Sprint 3**：填 Ch.8 Migration 與 Ch.9 Cross-cutting。此時夠穩定可具體
5. **Appendix 邊寫邊補** — 特別是詞彙表。review 時有人問「你的 X 是指什麼？」答案就進詞彙表

## 撰寫規則

### 先講 why、再講 what

每章開頭「為什麼這章存在」。skim 的讀者看技術細節前先懂章的存在理由。

### 可量化的都量化

「在容忍度內對帳」毫無價值。`< 0.01% row 級 diff × 14 天` 是測試條件。每個 SLO、每個門檻、每個遷移退出標準 — 寫成數字。

明確標出猜測：`reconcile tolerance: < 0.01%（target；於 Stage 0 load test 驗證）`。未來你會知道哪些數字是測出來的、哪些是推估。

### 反模式獨立一節

Ch.2（Principles）應有「反模式」一節列**不**該做什麼。比純原則易寫易 review。「別讓前端直接呼 DB」比「尊重領域邊界」具體。

### 引用 ADR、不內嵌決策

長決策屬於 ADR。北極星引用 `ADR-0005` 並說明後果。否則文件變沼澤。

## 文件穩定後做什麼

- **Review 頻率**：每季。頂部 changelog。大改組少見；Appendix 與 ADR Index 自然增長
- **Source of truth for**：架構問題、遷移狀態、Roadmap 階段。若答案是「問 architect」，答案就該在北極星
- **不 source of truth for**：tickets、sprint planning、個別 PRD。它們在 Linear / Jira / PRD 本身

## Review 時看什麼

review 別人的北極星草稿：
1. **Ch.0 是否獨立可讀？** 只讀 Ch.0 + Ch.7 Roadmap 的讀者應能簡報 VP
2. **Ch.1 數字真實嗎？** As-Is 要引用實際 metric，不是猜
3. **Ch.2 原則有反例嗎？** 沒有就是空話噪音
4. **Ch.8 migration 引用真協議？** kit 的 ADR-0001 Strangler Fig 是預設。客製協議需自己 ADR
5. **Ch.9 SLO 可測？** `高可用`模糊；`p95 < 250ms, error rate < 0.1%` 可測

## 相關

- [概念：ADR 模式](../concepts/adr-patterns.md)
- [概念：Strangler Fig](../concepts/strangler-fig.md)
- [Templates: 模組 Playbook](../templates/module-playbook-template.md)
