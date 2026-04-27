---
slug: /intro
sidebar_position: 1
---

# 總覽

**PM Workspace Kit** 是一份為「產出程式碼之前」的工作打造的範本集：產品探索、遷移規劃、跨團隊 review、以及讓這些產物在新鮮感褪去後仍可追蹤。

這份 kit 從一個真實的 18 個月 ERP 遷移規劃專案中萃取而來。原始領域內容（產品實體、模組 playbook、具體 SLO）已移除，留下的是**結構性骨架**、**在 CI 中強制它不腐化的腳本**，再加上一支 CLI（`pmk`）與一個 Slack gateway，把每個 PM 動詞包成可重複執行、且會落地成 repo 內可追蹤產物的對話。

## 你會得到什麼

整套 kit 共有三個產品面，背後共用同一份範本與同一份 traceability 核心。

### 1. 強制紀律的範本與腳本

- **`traceability.js`** — 掃描 markdown front-matter、驗證必填欄位、產出 Mermaid 依賴圖 + 反向引用 + 孤兒報告
- **`confluence-sync.js`** — 把 Confluence 的評論與狀態 label 拉回 Git，讓 reviewer 活動不會蒸發在 wiki 裡
- **ADR 範本**（MADR 風格）含 Alternatives Considered 與正負中三段式 Consequences
- **模組遷移 playbook** — 12 節，含 Stage 0–4 Strangler Fig checklist 與量化退出標準
- **北極星架構大綱** — 10 章骨架
- **PR / Code Review / Runbook / Dashboard / Readiness** — 五份交接文件

### 2. `pmk` CLI — 把 PM 動詞變成結構化對話

`pmk` 把 PM 工作流的每一段都包成一個命名動詞。每個動詞都是一段引導式的 LLM 對話，產物會落地成 repo 內可追蹤的檔案：

- `pmk propose` → PRD 訪談 → markdown 落到 `docs/prds/`
- `pmk ingest mra:--all` → 一次載入 `mra` workspace 內所有 repo 的 PKB 摘要
- `pmk discuss` / `ask` / `debug` → 有 grounding 的腦力激盪、RAG 查詢、假設驅動的除錯流程
- `pmk case open prod-checkout-503` → 跨 session 持續的長期 bug 調查檔案
- `pmk apply <plan>` → 把切細的計畫一步一步走，每一步等使用者確認
- **`pmk gateway`** → 起一個 Slack bridge，讓其他 PM、利害關係人在他們本來就在用的 Slack 裡直接 DM `pmk`；channel `@mention` 會自動開 case 檔案

### 3. 預先寫好的方法論 ADR

- **Strangler Fig 遷移協議** — 四階段 + 量化門檻 + rollback playbook
- **Dev Harness 約定** — Claude Code skills / hooks / subagents / MCP 在 monorepo 的分層規範
- **產品決策日誌** — 專屬 ADR 類別給產品面決策（定價、entitlement、MVP 切邊）
- **pmk × mra bridge** — 為什麼 CLI 把 code intelligence 委外給 [`multi-repo-agent`](https://github.com/hanfour/multi-repo-agent)，而不是自己長 grep
- **pmk gateway（Slack）** — 為什麼 messenger 介面採 host 自架 bridge，不採 SaaS bot

## 你不會得到什麼

- **專案管理工具**：tickets 還是留在 Linear / Jira
- **Wiki 替代品**：這 kit 跟 Confluence 合作，不取代它
- **自動生成架構**：決策仍由人做、ADR 仍需寫、遷移仍需規劃 — kit 只是給這些動作一個共同形狀
- **託管 SaaS**：CLI 與 gateway 都跑在你自己的機器上、對自己的 repo 操作；沒有任何資料離開 host

## 適合誰用

- **PM / SA**：公司已長出自由格式 Notion 文件以外的需求
- **工程主管**：即將規劃平台遷移、不想再面對 50 頁設計文件
- **Staff+ 工程師**：想要一套輕量 ADR + Strangler Fig 工具箱可直接塞進任何 repo
- **跨職能團隊**：希望利害關係人直接在 Slack 裡跟 PM artifact（PRD、case、決策）互動，而不是「請打開這個 Confluence 連結」

## 下一步

- [快速上手](./getting-started.md) — 10 分鐘從 clone 到第一份經驗證 front-matter 的 PRD（內附 CLI 快速試駕）
- [概念：追溯性](./concepts/traceability.md) — front-matter schema 與它存在的理由
- [範例：AcmeAds](./examples/acme-ads.md) — 虛構廣告公司的端到端使用範例
