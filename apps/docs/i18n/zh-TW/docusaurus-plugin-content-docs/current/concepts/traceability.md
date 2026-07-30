---
sidebar_position: 1
---

# 追溯性（Traceability）

每份追蹤文件在最前面帶一段 YAML front-matter，描述它是什麼、依賴什麼。腳本走這些區塊產出依賴圖、驗證報告、反向引用索引。不靠模糊文字搜尋 — 連結本身是結構化資料。

## Schema

```yaml
---
doc_id: PRD-YYYY-NNNN
title: 短的人類可讀標題
owner: "@github-handle"
status: Draft          # Draft | In Review | Approved | Deprecated
date: YYYY-MM-DD
related:
  requirement: []      # REQ-YYYY-NNNN 識別碼
  prd: []              # 上游 PRD
  spec: []             # SPEC-YYYY-NNNN
  plan: []             # plan 路徑或 ID
  architecture: []     # architecture 章節路徑
  adr: []              # ADR-NNNN 識別碼
  module: []           # 領域模組 ID
  confluence_page_id: null
---
```

### 文件類型與必填欄位

| Prefix | 類型 | 必填 `related.*` |
|---|---|---|
| `PRD-` | 產品需求 | `requirement` |
| `SPEC-` | 技術規格 | `prd` |
| `PLAN-` | 實作計畫 | _（僅基礎欄位）_ |
| `HANDOFF-` | 交接備忘 | _不驗證_ |

基礎必填：`doc_id`、`title`、`owner`、`status`、`date`。

## 為什麼選這個 schema

- **`doc_id` 不用檔名**：檔名會隨標題改，doc_id 穩定
- **巢狀 `related`**：意圖清楚，上游引用 vs 內容 metadata 分開
- **無 `children` / `blocks` 鍵**：雙向表達會有兩個地方要更新；挑一方向讓腳本算反向

## 驗證規則

1. Front-matter 是合法 YAML
2. 依類型必填欄位存在
3. `related.*` 目標是字串或字串陣列

空陣列允許。引用目標不存在不擋（刻意，支援前向引用佔位）。

## 融入工作流

- Pre-commit hook
- CI workflow（內建）
- Confluence 同步回流

## 相關

- [概念：DoR / DoD](./definitions-of-ready-done)
- [概念：ADR 模式](./adr-patterns)
- [指南：追溯矩陣](../guides/traceability-matrix)
