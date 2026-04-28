---
sidebar_position: 2
---

# 快速上手

10 分鐘走完：clone、安裝、寫第一份可追蹤的 PRD、故意讓驗證腳本失敗、再修好。

## 前置需求

- Node.js 20 以上
- Git
- Markdown 編輯器
- （選配）[`mra`](https://github.com/hanfour/multi-repo-agent) — 若要讓 `pmk` 能讀懂多 repo 程式碼才需要
- （選配）Anthropic API key 或 Claude Code 登入 — 跑 `pmk` 的 LLM 動詞才需要

## 1. Clone 並安裝

```bash
git clone https://github.com/hanfour/pm-workspace-kit.git my-workspace
cd my-workspace
npm install
```

## 2. 啟動文件站（選配）

```bash
npm start
```

本機瀏覽 `http://localhost:3000/pm-workspace-kit/`。可直接查看 templates 與 concepts。

## 3. 放入你的第一份追蹤文件

建立 `docs/prds/2026-Q3-example.md`：

````markdown
---
doc_id: PRD-2026-0001
title: 範例功能
owner: "@your-github-handle"
status: Draft
date: 2026-04-24
related:
  requirement: []
  plan: []
  spec: []
  architecture: []
  adr: []
  module: []
  confluence_page_id: null
---

# 範例功能

...你的 PRD 內容...
```

## 4. 跑驗證器

```bash
npm run traceability:check
```

成功輸出：

```
Traceability check: 1/1 passed
```

試刪掉 `owner` 那行再跑一次，會失敗 — 這就是重點：格式錯誤的文件沒法在 CI 通過。

## 5. 產生依賴圖

```bash
npm run traceability:matrix
```

開啟 `docs/traceability-matrix.md`：摘要、flat table、Mermaid 依賴圖、反向引用、孤兒清單。

## 6. 寫第一份 ADR

```bash
cp docs/templates/adr-template.md docs/adr/0001-your-decision.md
````

編輯 Context、Decision、Consequences、Alternatives Considered。在 PRD 的 `related.adr: [ADR-0001]` 反向連過來。

## 7. 接 Confluence 同步（選配）

若團隊發佈到 Confluence，見 [Confluence 同步指南](./guides/confluence-sync.md)。

## 8. 試用 CLI（選配）

第 1–7 步只用到「文件 + traceability」這一層。kit 還帶一支 `pmk` CLI，把每個 PM 動詞包成一段引導式 LLM 對話，產物會落地成 repo 內可追蹤的檔案。

```bash
npm run cli:build       # 編譯 packages/cli → dist
npx pmk --help          # 看所有動詞
```

兩個入門動詞：

```bash
# PRD 訪談 — 結果會落到 docs/prds/<slug>.md
npx pmk propose "weekly digest dashboard"

# 在你已索引的文件 corpus 上做 RAG（先跑 pmk index）
npx pmk index
npx pmk ask "how does our auth flow work?"
```

若希望利害關係人直接從 Slack 驅動 `pmk`，而不是進終端機：

```bash
npx pmk gateway init    # 一次性：貼上 Slack tokens + 設定 mra workspace 路徑
npx pmk gateway start   # 前景跑 bridge — 讓它一直跑
```

Gateway 是 host 自架的 Slack bridge（Socket Mode），不是 SaaS bot — token 與你的 code 都不離開你自己的機器。設計動機請見 [ADR-0006: pmk gateway](./adr/0006-pmk-gateway-slack.md)。

### v0.7 gateway 表面

v0.7.x 透過實際 Slack dogfood 把 gateway 磨成熟。在 `init` / `start` / `status` / `stats` 之外的關鍵指令：

```bash
# Audience 切換（tech / biz / exec）— 同樣答案、不同口吻
pmk gateway audience set <userId> biz       # 這個人收到的是商業語意優先的回覆
pmk gateway audience default tech           # 其他人的預設

# Escalation pool — PKB 與 mra-ask 都答不出時，pmk 要 @ 誰
pmk gateway escalation add <repo> <userId>  # repo 特定的人選
pmk gateway escalation add default <userId> # 沒指定 repo 時的後援

# Knowledge atoms — IT 回覆吸收後，24h TTL 才會被檢索
pmk gateway atoms list --pending            # 待生效清單
pmk gateway atoms show <id-prefix>          # 看完整內容
pmk gateway atoms approve <id-prefix>       # 提前生效（不等 24h）
pmk gateway atoms reject <id-prefix>        # 刪除
```

完整 gateway 流程 — *PM 在 Slack 問 → bot 看 PKB → 不夠就問 mra → 仍不夠就 @ 真人 → 吸收答案 → 下一個人問同樣問題直接命中* — 見 [PRD-2026-0005](./prds/2026-04-27-pmk-gateway-prd.md) 與 v0.7 系列 [release notes](https://github.com/hanfour/pm-workspace-kit/releases)。

## 接下來

- [概念：DoR / DoD](./concepts/definitions-of-ready-done.md)
- [指南：撰寫北極星](./guides/authoring-north-star.md)
- [Handoff 總覽](./handoff/overview.md)
