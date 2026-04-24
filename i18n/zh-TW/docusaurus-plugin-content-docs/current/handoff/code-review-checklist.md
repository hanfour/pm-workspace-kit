---
sidebar_position: 3
---

# Code Review Checklist

**目標**：review 聚焦在人類最擅長判斷的項目。自動化已處理的不再人工檢查。

## 0. 自動化門檻（CI 已檢、reviewer 跳過）

- Lint / typecheck / 單元測試 / ontology validate / traceability check — 全綠
- 覆蓋率 ≥ 80%
- Bundle size 無顯著增長

CI 紅就不用讀 diff。

## 1. 範圍與意圖

- [ ] PR title / summary 對應實際 diff（沒「順手改一堆」）
- [ ] Traceability 欄位填齊 — REQ / PRD / Spec / Module / ADR 至少有一引用源頭
- [ ] 動到 3+ 模組則拆 PR 或明確理由

## 2. 架構一致性

- [ ] 遵循 10 原則（domain-first boundary、single source of truth、type-safe end-to-end、無新 `any`）
- [ ] 無反模式：frontend 做 backend 的事、業務邏輯在 ORM callback、繞過 ontology codegen

## 3. Ontology / Schema 合規

- [ ] 新 entity / 欄位走 YAML + codegen、非手寫 schema
- [ ] 對應模組 playbook 的 Ontology Coverage 同 PR 或追蹤更新
- [ ] PII tier 標註（若新增 `confidential` / `restricted` 欄位）

## 4. 領域邊界

- [ ] Controller / route handler 只做 HTTP 綁定
- [ ] 跨模組呼叫走 event bus、不直呼 service
- [ ] Aggregate 守護不變量 — 外部不可改子 Entity
- [ ] 新 Value Object 集中驗證（Money / DateRange / VatNumber）

## 5. 遷移紀律（Strangler Fig）

- [ ] PR stage 對應實際程式行為
- [ ] 雙寫：新欄位在同 PR 加到新舊 schema
- [ ] 對帳指標在模組 SLO 內
- [ ] Stage 切換 2 人簽、flag 正確

## 6. AI / Agent 變更

- [ ] 新 tool 走 ontology codegen（5 標準 CRUD）或放 `custom/`
- [ ] `side_effects: write` 的 tool 有 HITL 規則（閾值 / 無條件）
- [ ] Prompt 有版本標記 + change log
- [ ] 新 prompt / tool 至少一個 eval regression case

## 7. 安全與隱私

- [ ] AuthN/Z 正確 — 新 endpoint 有 `@Roles` + 適當 `@Policy`
- [ ] PII 沒進 log / prompt / response body
- [ ] 無 hardcoded secret
- [ ] 系統邊界輸入驗證（Controller DTO / Server Action / Webhook）

## 8. 測試品質

- [ ] 測試名稱像規格（不是 testFooBar）
- [ ] 覆蓋邊界（nil / 空 / 非法 / 併發）
- [ ] 測試獨立無順序依賴
- [ ] Bug-fix PR 有**回歸測試**先 red 後 green

## 9. Observability

- [ ] 新 service method 有 OTel span
- [ ] 業務錯誤分類為 `DomainError` / `ValidationError` — 不丟 generic `Error`
- [ ] 新 alert / dashboard panel 若不在本 PR 則開 follow-up ticket

## 10. 可讀性

- [ ] 檔案 ≤ 800 行（目標 200–400）
- [ ] 函式 ≤ 50 行
- [ ] 巢狀 ≤ 4 層
- [ ] 命名清楚、無魔術數字
- [ ] 註解只解釋 why、不重述程式碼

## Hard-blocker（有 approvals 也不得 merge）

- ❌ 繞過 ontology codegen（手改 `generated/`）
- ❌ 去除金流 / PII / 不可逆動作的 HITL
- ❌ 覆蓋率低於 PR baseline
- ❌ 新 `any` / `@ts-ignore` / `eslint-disable` 無明顯理由
- ❌ Secrets / keys 在 diff 可見

## Comment 慣例

| 前綴 | 意義 | 作者行動 |
|---|---|---|
| `blocking:` | 必須修才 merge | 修 |
| `nit:` | 個人偏好 | 可略 |
| `question:` | 理解設計 | 回答 |
| `praise:` | 值得肯定 | 無行動 |
| `idea:` | 未來改進 | 開 follow-up issue |
