---
sidebar_position: 1
---

# 範例：AcmeAds

虛構廣告技術公司端到端使用 kit 的示範。顯示採用 traceability + ADR + 模組 playbook 後的真實 workspace 長什麼樣。所有名字與資料都是虛構、文件形狀是真實的。

## 設定

**AcmeAds** 是程序化廣告平台。正從 Python monolith（5 年老 Flask app）遷到 TypeScript 服務化系統。類 ERP 領域有四個核心模組：`crm`、`billing`、`campaigns`、`reporting`。

## 範例內容

在 repo [`examples/acme-ads/`](https://github.com/hanfour/pm-workspace-kit/tree/main/examples/acme-ads) 下：

```
examples/acme-ads/
├── README.md
├── ontology/
│   └── systems/
│       └── crm.yaml              # 3 entities: Customer, Contract, Contact
├── docs/
│   ├── prds/
│   │   └── 2026-Q2-customer-onboarding-prd.md
│   ├── architecture/
│   │   └── modules/
│   │       └── crm-customer-migration.md
│   └── adr/
│       └── 0004-go-monolith.md    # 本專案技術 ADR
```

## 先看什麼

### 1. 有真 front-matter 的 PRD

[`docs/prds/2026-Q2-customer-onboarding-prd.md`](https://github.com/hanfour/pm-workspace-kit/tree/main/examples/acme-ads/docs/prds/2026-Q2-customer-onboarding-prd.md) 顯示：
- 用了必填 `doc_id`、`related.requirement`、`related.module` 欄位
- 引用 ADR（`ADR-0004`）驅動技術方向
- 回連到有自己 playbook 的特定模組（`crm.customer`）

對 example 目錄跑 `npm run traceability:matrix --cwd=examples/acme-ads` 可看圖。

### 2. 情境內的模組 playbook

[`docs/architecture/modules/crm-customer-migration.md`](https://github.com/hanfour/pm-workspace-kit/tree/main/examples/acme-ads/docs/architecture/modules/crm-customer-migration.md) 填了 `crm.customer` 的 12 節模板。注意：
- 依賴圖連到相鄰模組（`billing`、`campaigns`）
- Stage 0 checklist 項目具體（ontology 缺口、遷移 script、feature flag）
- 風險標 likelihood × impact、不是空話
- 模組特殊 override：客戶資料 PII 敏感 → 對帳容忍度緊 5 倍

### 3. 技術 ADR

[`docs/adr/0004-go-monolith.md`](https://github.com/hanfour/pm-workspace-kit/tree/main/examples/acme-ads/docs/adr/0004-go-monolith.md) 是**技術** ADR 範例（接在 0001–0003 方法論之後）。展示 Deciders、Alternatives、Consequences 完整填寫的形狀。

### 4. Ontology

[`ontology/systems/crm.yaml`](https://github.com/hanfour/pm-workspace-kit/tree/main/examples/acme-ads/ontology/systems/crm.yaml) — 三個 entity 含欄位、associations、PII tier、business rule。一次看完、但足以展示形狀。

## 跑範例

```bash
# v0.2 起 scripts 支援 --cwd flag
node scripts/traceability.js matrix --cwd=examples/acme-ads
node scripts/traceability.js check --cwd=examples/acme-ads
```

## 此範例刻意省略的

為了讀性精簡：
- 完整 10 章北極星文件（模板見 [Guide: 撰寫北極星](../guides/authoring-north-star.md)）
- Monitoring dashboard JSON（平台相依）
- Confluence sync 實際運作（需 live credential）
- 多模組配對遷移順序（概念見 [Strangler Fig](../concepts/strangler-fig.md)）

## 複製到你的專案時

1. 從頭開始：範例的 `doc_id` 從 `PRD-2026-0001`、`ADR-0004` 開始。你可重編號對應自己歷史
2. 刪「acme」名字、填真的
3. YAML / front-matter 形狀是可重用部分。實際欄位與業務規則是你的

## 相關

- [快速上手](../getting-started.md)
- [Templates: 模組 Playbook](../templates/module-playbook-template.md)
- [概念：追溯性](../concepts/traceability.md)
