---
sidebar_position: 2
---

# PR 範本

複製下方區塊到實作 repo 的 `.github/pull_request_template.md`。

---

````markdown
## Summary

<!-- 1-3 句：what + why。避免只寫 what。 -->

## Traceability

- **REQ**: REQ-YYYY-NNNN（或 N/A）
- **PRD**: PRD-YYYY-NNNN（或 N/A）
- **Spec**: SPEC-YYYY-NNNN（或 N/A）
- **Module**: <module_id>（或 cross-cutting）
- **ADR**: ADR-NNNN（影響架構時）
- **Confluence**: <page_id>（已發佈時）

> CI `traceability-check` 驗證任何新 / 改動的 `docs/prds/**`、`docs/specs/**`、`.claude/plans/**` 帶必填 front-matter。

## 變更類型

- [ ] feat
- [ ] fix
- [ ] refactor
- [ ] perf
- [ ] docs
- [ ] test
- [ ] chore / build / ci

## 遷移（若適用 Strangler Fig）

- **Module**: <module_id>
- **Stage**: ☐ 0 Prep / ☐ 1 Shadow Read / ☐ 2 Double Write / ☐ 3 Cutover / ☐ 4 Retire
- **Feature flag**: `migration.<module>.mode = ...`
- **對帳差異（24h）**: ___%（需低於模組 SLO）
- **階段轉換雙簽**: @reviewer-1, @reviewer-2

## 風險與 Rollback

- **Risk tier**: ☐ P0（金流 / PII / 法遵）/ ☐ P1 / ☐ P2 / ☐ P3
- **Blast radius**: ☐ 單模組 / ☐ 跨模組 / ☐ 跨系統（含外部）
- **Rollback plan**: <feature flag / deploy 回退 / db migration down — 目標 < 5 min>
- **HITL impact**: ☐ 不變 / ☐ 新增 / ☐ 修改 / ☐ 移除（移除需 Architect 核准）

## 驗證

- [ ] 單元測試（覆蓋率 ≥ 80%）
- [ ] Integration（若涉 DB / 跨模組）
- [ ] E2E（若涉關鍵 UI 流程）
- [ ] Eval（若涉 LLM prompt / tool）
- [ ] 本機 `npm run traceability:check` 通過
- [ ] Ontology / schema 驗證通過（若適用）

## 資料 / Schema 變更

- [ ] 無
- [ ] 僅 Ontology YAML（codegen 重新產、review generated/）
- [ ] 包含 migration（up + down SQL；zero-downtime 路徑）
- [ ] 跨模組結構變更（需 ≥ 2 module-owner 簽核）

## 給 reviewer 的備註

<!-- 需先知道的 context：取捨、已知限制、追蹤項 -->

## 截圖 / 錄影（UI）

<!-- -->

---

**PR title 慣例**: `<type>(<scope>): <祈使句摘要>`
範例：`feat(billing.invoice): add partial-payment handling`
````

## 用法

- Template 在每次新 PR 觸發。保留**所有**段落；不適用就寫 `N/A`
- `Traceability` 欄位是主要 CI gate。沒東西可引用時 reviewer 應該問為什麼
- `HITL impact` 刻意簡短。去除金流寫的 HITL 是 hard-blocker 不管誰核准 — 見 [Code Review Checklist](./code-review-checklist)
