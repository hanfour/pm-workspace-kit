---
sidebar_position: 1
---

# ADR 索引

kit 預寫 3 條**方法論** ADR，可直接採用或調整。這些是**如何工作**的決策，不是選什麼技術棧。

| # | 標題 | Status | 日期 |
|---|---|---|---|
| [ADR-0001](./0001-strangler-fig-protocol.md) | Strangler Fig 遷移協議 | Accepted | 2026-04-24 |
| [ADR-0002](./0002-dev-harness.md) | Dev harness 約定 | Accepted | 2026-04-24 |
| [ADR-0003](./0003-product-decision-log.md) | 產品決策記錄（first-class ADR 類別） | Accepted | 2026-04-24 |

## 如何使用

1. 作為你 repo 的起始 ADR-0001/0002/0003，或重編號對齊你的序列
2. 技術 ADR（monorepo / backend 框架 / ORM 等）從 0004+ 開始
3. 新 ADR 用 [`docs/templates/adr-template.md`](../templates/adr-template.md)

## 如何新增 ADR

1. 複製 `docs/templates/adr-template.md` 到 `docs/adr/NNNN-<slug>.md`（下一編號）
2. 填：Status（初為 Proposed）、Date、Deciders、Tags、Context、Decision、Consequences、Alternatives、References
3. 加行到本 index
4. PR → Architect + senior eng review → merge；status 改 Accepted

## Status 生命週期

`Proposed` → `Accepted` → (`Deprecated` | `Superseded by ADR-XXXX`)

絕不刪 deprecated ADR。保留軌跡。
