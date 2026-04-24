---
slug: /intro
sidebar_position: 1
---

# 總覽

**PM Workspace Kit** 是一份為「產出程式碼之前」的工作打造的範本集：產品探索、遷移規劃、跨團隊 review、以及讓這些產物在新鮮感褪去後仍可追蹤。

這份 kit 從一個真實的 18 個月 ERP 遷移規劃專案中萃取而來。原始領域內容（產品實體、模組 playbook、具體 SLO）已移除。留下的是**結構性骨架**與**在 CI 中強制它不腐化的腳本**。

## 你會得到什麼

### 強制紀律的腳本

- **`traceability.js`** — 掃描 markdown front-matter、驗證必填欄位、產出 Mermaid 依賴圖 + 反向引用 + 孤兒報告
- **`confluence-sync.js`** — 把 Confluence 的評論與狀態 label 拉回 Git，讓 reviewer 活動不會蒸發在 wiki 裡

### 終結爭論的範本

- **ADR 範本**（MADR 風格）含 Alternatives Considered 與正負中三段式 Consequences
- **模組遷移 playbook** — 12 節，含 Stage 0–4 Strangler Fig checklist 與量化退出標準
- **北極星架構大綱** — 10 章骨架
- **PR / Code Review / Runbook / Dashboard / Readiness** — 五份交接文件

### 預先寫好的方法論 ADR

- **Strangler Fig 遷移協議** — 四階段 + 量化門檻 + rollback playbook
- **Dev Harness 約定** — Claude Code skills / hooks / subagents / MCP 在 monorepo 的分層規範
- **產品決策日誌** — 專屬 ADR 類別給產品面決策（定價、entitlement、MVP 切邊）

## 你不會得到什麼

- **專案管理工具**：tickets 還是留在 Linear / Jira
- **Wiki 替代品**：這 kit 跟 Confluence 合作，不取代它
- **自動生成架構**：決策仍由人做、ADR 仍需寫、遷移仍需規劃 — kit 只是給這些動作一個共同形狀

## 適合誰用

- **PM / SA**：公司已長出自由格式 Notion 文件以外的需求
- **工程主管**：即將規劃平台遷移、不想再面對 50 頁設計文件
- **Staff+ 工程師**：想要一套輕量 ADR + Strangler Fig 工具箱可直接塞進任何 repo

## 下一步

- [快速上手](./getting-started.md) — 10 分鐘從 clone 到第一份經驗證 front-matter 的 PRD
- [概念：追溯性](./concepts/traceability.md) — front-matter schema 與它存在的理由
- [範例：AcmeAds](./examples/acme-ads.md) — 虛構廣告公司的端到端使用範例
