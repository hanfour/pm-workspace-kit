---
sidebar_position: 1
---

# 追溯矩陣（使用指南）

`traceability.js` 腳本一步步：讀什麼、產什麼、如何接 CI、如何讀結果矩陣。

## 讀取範圍

預設掃這些目錄下有 `doc_id` front-matter 的 markdown：

```
docs/prds/
docs/specs/
docs/plans/
docs/requirements/
docs/handoff/
.claude/plans/
```

改 `SCAN_DIRS`（在 `scripts/traceability.js`）加減路徑。

## 指令

```bash
# 產生矩陣
npm run traceability:matrix

# 全量驗證
npm run traceability:check

# 指定檔案驗證（pre-commit 用）
node scripts/traceability.js check docs/prds/2026-Q3-example.md

# 對 sub-repo 驗證（新功能）
node scripts/traceability.js matrix --cwd=examples/acme-ads
```

## 矩陣五段

跑完後開 `docs/traceability-matrix.md`：

### 1. Summary
依類型、edge 類型的總數。

### 2. Flat table
每個 primary doc 一列。欄位：`doc_id`、title、status、各類 related ref、路徑。

### 3. Dependency graph
Mermaid `graph LR`，依類型上色。Primary 是方框；**virtual** 節點（被引用但自身未追蹤，典型為 ADR、module、architecture 路徑）是圓角矩形。

GitHub / GitLab / Docusaurus / Obsidian / VS Code preview 都能直接渲染。

### 4. Reverse lookup（反向引用）
每個有 incoming ref 的 target 列出誰指過來、透過哪個 `related.*` key。

這是回答「若我 deprecate ADR-0011，誰會壞？」的地方。

### 5. Orphans & isolation
兩個列表：
- **無 outgoing ref**：不引用任何上游。對 standalone retrospective 可接受；對應該引用需求的 PRD 是 suspicious
- **Primary-to-primary 引用比例**：追蹤的文件中有多少比例以 doc_id 引用另一份 tracked doc。若為零、圖完全流進 virtual 節點 — 初期正常、隨著更多跨文件引用而改善

## CI 整合

kit 提供 `.github/workflows/traceability-check.yml`：
1. PR 改到 `docs/prds/**`、`docs/specs/**`、`docs/plans/**`、`.claude/plans/**` 或腳本時觸發
2. 對變更檔跑 `npm run traceability:check`
3. 重生矩陣、若 committed 版本過期則 fail

「過期矩陣」這招是關鍵 — 強制貢獻者新增追蹤文件時重生矩陣。

### 本機 pre-commit hook（選配）

```bash
# .husky/pre-commit
changed=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.md$' || true)
if [ -n "$changed" ]; then
  node scripts/traceability.js check $changed
fi
```

在 CI 擋下之前先在本機 fail。

## 讀圖範例

若重生矩陣得：
```
PRD-2026-0005 → REQ-2026-0042
PRD-2026-0005 → module/billing
SPEC-2026-0008 → PRD-2026-0005
SPEC-2026-0008 → ADR-0011
PLAN-2026-Q3 → SPEC-2026-0008
```

告訴你：
- `REQ-2026-0042` 驅動 `PRD-2026-0005`。需求卡改範圍、PRD 要 review
- `PRD-2026-0005` 觸及 `module/billing`。billing 模組的 PR 要對照本 PRD
- `ADR-0011` 對 `SPEC-2026-0008` 承重。deprecate ADR-0011 有直接 spec 依賴
- `PLAN-2026-Q3` 遞迴繼承以上

Backlinks 段：`ADR-0011` 顯示 `SPEC-2026-0008` 為唯一 referrer。Orphans 段：若 `REQ-2026-0042` 無 outgoing 會被標（實際不會 — 需求卡是 leaf）。

## 新增文件類型

追蹤新類型如 `OBSRV-`（觀測性文件）：
1. 加到 `REQUIRED_FIELDS`：
   ```js
   REQUIRED_FIELDS.OBSRV = ["doc_id", "title", "owner", "status", "date"];
   ```
2. `renderMermaid()` 加對應 classDef 色
3. （若相關）新目錄加到 `SCAN_DIRS`

保持依賴少：腳本只用 `gray-matter`。抗拒把 parser / schema 塞進來。

## 何時重生

- 新增 / 重命名 / 退役追蹤文件後
- 改任何 `related.*` 區塊後
- CI 每 PR 自動重生；本機只在檢查時才需

檔案對同一 tree 是 deterministic — 沒變動時重跑產出 byte-identical，`git diff` 為空除非真的有變動。

## 相關

- [概念：追溯性](../concepts/traceability)
- [Guide: Confluence Sync](./confluence-sync) — wiki → Git 反向流
