# Brief — codegraph 評估與 PoC 實測（2026-07）

## 為什麼寫這份

評估 [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) 對 PMK 的
升級價值，並把 2026-07-16 在 host 上做的第 1 步 PoC 實測數據存檔。後續三個決策
（A/B review 實測、mra 整合、doc↔code bridge）都以這份數據為基準，避免重測或
憑印象決策。

## codegraph 是什麼（一段版）

Tree-sitter 把 20+ 語言解析成 AST，抽出 symbols（函式/類別）與 edges（呼叫/
import/繼承/框架路由），存本地 SQLite+FTS5；file-watch 增量同步；以 MCP server
暴露單一強工具 `codegraph_explore`，一次呼叫回傳相關 symbol 原始碼 + call path +
blast radius。官方實測宣稱：58% fewer tool calls、22% faster、file reads 趨近 0。

**盡職調查（2026-07-16）**：MIT license、60.2k stars、活躍維護（v1.4.1,
2026-07-10）、local-only 零資料外傳、telemetry 可關。單一主要作者但有社群貢獻。
成熟度可接受，但 1.x 尚新，API 可能變動。

## PoC 實測數據（第 1 步，2026-07-16）

**環境**：host macOS、node v24.18.0、codegraph 1.4.1（npm 全域安裝，4 秒）。
**對象**：`~/OneAD/erp` — workspace 最大 repo（5,512 tracked files、Rails/Ruby
4,339 個 .rb、review 最活躍，如 onead/erp#4899）。

### 效能

| 項目 | 實測值 | 對照 |
|------|--------|------|
| 首次索引 | 4,677 檔 → **25,431 nodes / 48,956 edges，核心 14.3s（總 27.7s）** | `mra analyze` 產 PKB 需數分鐘 |
| DB 大小 | **96MB**（自帶 `.gitignore`，不汙染 git status） | repo 本體 145M |
| 增量 sync（改 1 檔） | **核心 0.37s / 總 1.16s** | review-clone「copy db + sync」模式可行的關鍵 |
| Telemetry | 已用 `codegraph telemetry off` 關閉 | 符合 PMK 安全姿態 |

### 品質（用 PMK gateway 實際被問過的領域測）

| 能力 | 結果 |
|------|------|
| Symbol search（`AdFormat`） | ✅ 正確列 class + 檔案:行號 |
| `--json` 輸出 | ✅ 含 `qualifiedName`（`Api::V2::Oym::OptionsController::ad_formats`）、行號、score，可直接機器消化 |
| `impact`（blast radius） | ✅ `AdFormat` 59 個受影響符號；本 branch 改動的 `AccountManagementService` 32 個，按檔案分組 |
| `explore` 英文 | ✅✅ "how is department advertising budget allocation calculated" → **2.2 秒**回 `BudgetSpentCalculator` + **38 callers** 清單 + 繼承鏈 + instantiation + **「⚠️ no covering tests found」** |
| `explore` 中文 | ❌ 「各部門廣告預算分配比例如何計算」→ **零結果**（FTS 關鍵字檢索、非語意嵌入；符號全英文） |
| `affected --stdin`（test-impact from git diff） | ⚠️ 可用，但 erp 改動檔無覆蓋測試 → 無訊號（erp 有 611 個 test 檔但關鍵 service 裸奔） |
| `node`（單符號大綱） | ✅ 結構大綱 + 誠實引導「要 body 請讀檔」 |

### 兩個關鍵發現

1. **中文限制不是阻礙但要設計**：Slack 問題是中文，`explore` 吃英文關鍵字。
   agent 場景（mra-ask / review agent 呼叫 MCP 工具時自組英文查詢）天然可用；
   但任何「gateway 直連 codegraph」的設計都需先過一層中→英關鍵字轉換。
2. **「no covering tests」旗標是意外之財**：對 `:cr:` review，reviewer 開局就知道
   哪些改動沒有測試保護——在 erp 這種測試覆蓋弱的 repo，此旗標比 `affected`
   更有價值。

## 與 PMK 現況對照

| 面向 | PMK/mra 現況 | codegraph | 意義 |
|------|-------------|-----------|------|
| 程式碼知識 | PKB = 4 份 LLM 生成 markdown（sitemap/architecture/conventions/api-surface），`mra analyze` 數分鐘、會過期（`pkbNeedsBuild`） | 確定性 AST graph，14s 全量、0.4s 增量 | 結構性事實不該用 LLM 重複生成；prose 判斷力（conventions/architecture）仍是 PKB 價值 |
| Review 探索 | 無 PKB 時 review agents grep 整庫 → 耗盡 max-turns(40) → REVIEW_INCOMPLETE（review.ts 註解明載的根因） | `impact`/`explore` 直接給 blast radius | **正中 REVIEW_INCOMPLETE 根因** |
| 檢索失效處理 | atom-index mtime 判斷（issue #83 flaky） | staleness banner：過期明講，agent 改走直讀 | 誠實降級模式可借鏡 |
| 圖思維 | `traceability.js` 已有 doc graph（PRD→SPEC→module 虛擬節點） | code graph | 兩張圖可橋接（見 T3） |

## 升級路線（三層）

- **T1 直接採用（主戰場在 mra，遵守 ADR-0005）**：host 索引 mraWorkspace 各
  repo；`codegraph install` 讓 claude/codex CLI 拿到 MCP；PMK 端比照 PKB copy
  模式在 `prepareReviewClone` 複製 `.codegraph/` + 增量 sync；review prompt 注入
  `impact`/`no-covering-tests` 前情。
- **T2 模式借鏡（不引依賴）**：staleness banner（#83 類問題的誠實解法）、
  single-powerful-tool 設計哲學、measured coverage（呼應 #62 atom audit）、
  `provenance:'heuristic'` 標記。
- **T3 PMK 獨有：doc↔code traceability bridge**：front-matter `related.module` ↔
  code symbols → PR review 時反查「blast radius 落在哪些 SPEC/PRD 範圍」。
  codegraph 是工程師工具，永遠不會做 doc↔code 追溯；這是 PMK（traceability has
  teeth）的差異化機會。

## 下一步：第 2 步 A/B 設計（尚未執行）

同一個真實 PR 跑兩次 `:cr:`（或用 `mra review` 直跑）：

- **A 組**：現況（PKB only）
- **B 組**：`codegraph install` 接 MCP 後
- **量測**：agent turns、wall-clock、token、REVIEW_INCOMPLETE 是否發生、
  findings 品質（有無因結構上下文而多抓/少漏）
- **判準**：B 組 turns/時間顯著下降且 findings 不劣化 → 進 T1 實作
  （mra 端 PR + PMK 端 clone-copy PR）

## 未決問題（做第 2 步前要驗證）

1. **stripped env 下 MCP 可達性**：mra 用 `reviewEnv`（strippedChildEnv）跑
   provider；MCP 設定來自 `~/.claude.json` / codex config 檔而非 env，理論上
   不受 strip 影響——需實跑確認。
2. **review clone 的索引策略**：clone checkout 的是 PR head，主 clone 是 main
   → 必須 copy db + `codegraph sync`（增量 0.4s/檔，PR 級 diff 可忽略），不能
   用 `projectPath` 指回主 clone（內容不同）。
3. **多 repo 成本**：96MB × N repos；workspace 全索引前先挑 review 活躍的
   2-3 個（erp、super-dsp-2.0）。
4. **1.x API 穩定度**：CLI 旗標已見變動（`affected` 需 `--stdin`、`init` 無
   `--yes`）；整合層要薄、可替換。

## 現狀記錄

- host 已裝 codegraph 1.4.1（npm global）、telemetry off
- `~/OneAD/erp/.codegraph/`（96MB）保留作持久索引
- 尚未執行 `codegraph install`（未動任何 agent 設定檔）
