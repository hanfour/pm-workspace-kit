---
sidebar_position: 3
---

# ADR 模式

Architecture Decision Records（ADR）記錄**為什麼**做這個選擇。程式碼回答 what；ADR 回答 why。半年後團隊成員問「可以改用 X 嗎？」時，ADR 就是你避免重新辯論的工具。

本 kit 預寫 3 條**方法論** ADR（Strangler Fig、Dev Harness、Product Decision Log）。其他由你決定 — kit 只給格式。

## 格式（MADR-lite）

````markdown
# ADR-NNNN: <決策標題>

- **Status:** Proposed | Accepted | Deprecated | Superseded by ADR-XXXX
- **Date:** YYYY-MM-DD
- **Deciders:** @owner, @reviewer-1
- **Tags:** backend, frontend, migration, ...

## Context
為什麼現在需要這個決策？限制條件？

## Decision
決定什麼？一句話開頭，再補細節。

## Consequences

### Positive
- ...

### Negative
- ...

### Neutral
- 需關注但不阻擋的事。

## Alternatives Considered

### Alternative A：<名稱>
- Pros:
- Cons:
- Rejected because:

## References
- 連結、先前 ADR、外部文件。
````

模板在 [`docs/templates/adr-template.md`](../templates/adr-template.md)。

## 兩類 ADR

### 技術 ADR（慣例編號 0001–0010）
框架選型、資料庫、訊息匯流排、部署拓撲。Deciders 通常 Architect + senior eng。

### 產品決策記錄
定價、entitlement 規則、MVP 範圍、功能門禁。Deciders 通常 PM Lead + Architect。相同格式，不同領域。kit 的 **ADR-0003 Product Decision Log** 是 meta-ADR，讓這類決策成為 first-class，不再被埋在 PRD appendix。

## 追溯性 ADR

決策已在三個月前的會議做完、已在 production，還是要寫 ADR。Status 標 `Accepted` 加 `Recorded: YYYY-MM-DD`，Alternatives Considered 從記憶補。

審計軌跡存在、未來的你不用猜、若新成員挑戰決策你有文件可辯護或優雅退役。

## 何時不寫 ADR

- 可逆、單 PR 變更（命名、lint 規則、config 值）— PR description 就夠
- 會在一個 sprint 內被推翻的決策
- 「如何實作 X」— 這是 spec，不是 ADR。ADR 是**選哪個選項**，不是某個選項的 playbook。

## Deprecation / Supersession

不刪舊 ADR。做法：
- 改 status 為 `Deprecated`，頂部加一行說明什麼取代它
- 若有直接繼承：`Superseded by ADR-NNNN` 加連結
- 讀者進 ADR-0042「Use MySQL」看到 deprecated、跟連結到 ADR-0087「Use Postgres」、得到切換的 context

## 歸檔慣例

一個 ADR 一個檔，依序編號，放 `docs/adr/`。維護 `docs/adr/README.md` index（本 kit 有一份）。**永遠不重用編號**即使 ADR 被放棄 — 標 `Deprecated` 就好。

## 建議早期寫的 ADR

任何非平凡專案：
1. **Monorepo 策略**
2. **Backend framework**
3. **ORM / persistence**
4. **Migration protocol** — kit 提供 ADR-0001 Strangler Fig
5. **Dev harness 約定** — kit 提供 ADR-0002
6. **Product decision log** — kit 提供 ADR-0003

## 相關

- [Templates: ADR](../templates/adr-template.md)
- [概念：Strangler Fig](./strangler-fig.md)
