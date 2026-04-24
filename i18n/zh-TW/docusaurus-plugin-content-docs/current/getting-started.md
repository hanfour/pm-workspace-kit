---
sidebar_position: 2
---

# 快速上手

10 分鐘走完：clone、安裝、寫第一份可追蹤的 PRD、故意讓驗證腳本失敗、再修好。

## 前置需求

- Node.js 18 以上
- Git
- Markdown 編輯器

## 1. Clone 並安裝

```bash
git clone https://github.com/hanfourhuang/pm-workspace-kit.git my-workspace
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

## 接下來

- [概念：DoR / DoD](./concepts/definitions-of-ready-done.md)
- [指南：撰寫北極星](./guides/authoring-north-star.md)
- [Handoff 總覽](./handoff/overview.md)
