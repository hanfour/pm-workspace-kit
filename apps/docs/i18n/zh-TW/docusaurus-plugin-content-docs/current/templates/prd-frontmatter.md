---
sidebar_position: 3
---

# PRD Front-matter 範本

放在每個新 PRD 最前面。替換 placeholder。`traceability:check` 驗證必填欄位。

```yaml
---
doc_id: PRD-YYYY-NNNN
title: <短人類標題>
owner: "@<github-handle>"
status: Draft          # Draft | In Review | Approved | Deprecated
date: YYYY-MM-DD
related:
  requirement: []      # REQ-YYYY-NNNN — 來源需求卡
  plan: []
  spec: []
  architecture: []
  adr: []
  module: []
  confluence_page_id: null
---
```

## 逐欄位規則

| 欄位 | 必填？ | 備註 |
|---|---|---|
| `doc_id` | 是 | 須符合 `PRD-YYYY-NNNN` |
| `title` | 是 | 短、人類可讀。非檔名 |
| `owner` | 是 | GitHub handle、加引號避 YAML parser 誤判 |
| `status` | 是 | 四值之一；空字串會 fail |
| `date` | 是 | ISO 8601 |
| `related.requirement` | 是（驗證） | 綠地可空陣列 `[]` |
| `related.*`（其他） | 否 | 建議保留空陣列整齊 |

## Status 狀態機

```
Draft → In Review → Approved
           ↓          ↓
        Draft     Deprecated
```

- `Draft`：作者撰寫中。尚無 reviewer
- `In Review`：準備 review。Reviewer 在 Confluence（或 PR）留言並核准
- `Approved`：決策完成。下游（spec / plan）可開工
- `Deprecated`：不再 source of truth。用 `related.prd` 連到繼承者

## 範例

```yaml
---
doc_id: PRD-2026-0015
title: 客戶自助發票下載
owner: "@alice"
status: In Review
date: 2026-05-12
related:
  requirement: [REQ-2026-0080]
  plan: []
  spec: [SPEC-2026-0020]
  architecture: []
  adr: [ADR-0008]
  module: [billing.invoice, billing.portal]
  confluence_page_id: "123456789"
---
```

## 相關

- [概念：追溯性](../concepts/traceability) — 完整 schema 說明
- [概念：DoR / DoD](../concepts/definitions-of-ready-done) — PRD 何時可寫 vs 可出貨
