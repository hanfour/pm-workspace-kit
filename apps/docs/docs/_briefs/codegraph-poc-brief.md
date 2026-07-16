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

## 第 2 步 A/B 設計（已執行，結果見下節）

同一個真實 PR 用 `mra review` 直跑兩組：

- **A 組**：現況（PKB only）
- **B 組**：注入 codegraph 結構上下文（原計畫走 MCP，實測發現 mra 的
  temp-HOME 隔離使 MCP 不可達，改用 `MRA_REVIEW_SUPPLIED_CONTEXT` 注入）
- **量測**：wall-clock、token、REVIEW_INCOMPLETE 是否發生、findings 品質
- **判準**：B 組時間顯著下降且 findings 不劣化 → 進 T1 實作
  （mra 端 PR + PMK 端 clone-copy PR）

## 第 2 步 A/B 實測結果（2026-07-16，已完成）

**設計**：onead/erp PR #4890（+496/-7、17 檔、DV360 功能）、head `6ee5d625a`。
雙獨立 clone（scratchpad，PR head checkout，不碰主 clone）、
`MRA_REVIEW_POST_MODE=none`（零 GitHub 寫入）、`--base development`、
provider codex + strategy standard（= production 設定）。B 組經
`MRA_REVIEW_SUPPLIED_CONTEXT` 注入 8.8KB codegraph 結構上下文（changed files
+ 各 changed symbol 的 `impact` blast radius，機械化生成、秒級）。
另跑 PKB-less 變體（A′/B′）測「codegraph 能否替代 PKB」假說。

### 結果矩陣（皆為完成跑；重試見下方失敗記錄）

| 組 | PKB | codegraph | 時間 | Verdict | Findings | Tokens |
|---|-----|-----------|------|---------|----------|--------|
| A | ✓ | ✗ | 84s | CR ✓完成 | 2（1H+1M） | 36,629 |
| B | ✓ | ✓ | 102s | CR ✓完成 | 2（1H+1M） | 39,303 |
| A′ | ✗ | ✗ | **70s** | CR ✓完成 | **3**（1H+2M） | **26,428** |
| B′ | ✗ | ✓ | 100s | CR ✓完成 | 3（1H+2M） | 29,804 |

跨四跑的真實問題聯集共 5 個（migration 缺回填、duplicate 缺 external_cost、
`to_status` 對無走期 draft 會 `nil.to_date` crash、duplicate 保留 trash 旗標、
未驗證 `start_date <= end_date`）；單跑各抓 2-3 個，**抓到哪幾個的 run-to-run
變異大於任何 A/B 組間差**。

### 判準結論：不達標

1. **codegraph prompt 注入對 codex 單趟 review 無效益**：有 PKB 時 B 較 A
   慢 21%、多 7% tokens、findings 數相同；無 PKB 時 B′ 較 A′ 慢 43%、
   findings 數相同。時間未降、findings 未明顯提升 → **T1 的 prompt-injection
   版整合（codex 路徑）不做**。
2. **意外發現——PKB 對 codex 單趟也不見得 load-bearing**：PKB-less 的 A′
   反而最快（70s）、最省（26.4k tokens）、findings 最多（3）。codex exec
   單趟不做多輪探索（`max-turns` 對 codex 無效，見 model-provider.sh），
   「探索成本」假說根本不適用於這條路徑——它適用的是 **claude 多輪
   agent 路徑**（mra-ask、claude review provider、debate strategy），本輪未測。
3. **REVIEW_INCOMPLETE 在完成跑中一次都沒因探索限制發生**——所有 incomplete
   都來自 provider transport 故障（見下）。

### 附帶發現：production REVIEW_INCOMPLETE 的具體機制（比 A/B 本身更有價值）

7 次嘗試中 3 次失敗，全是 transport 層：

1. **TTL-auth race（2 次，簽名完全相同）**：sub2api relay 串流中斷 → codex
   `Reconnecting... 1/5→5/5` → 重連時重讀 auth.json → **已被 mra 的
   `MRA_CODEX_AUTH_FILE_TTL_SECONDS`（預設 1 秒）刪除** → 401
   `API_KEY_REQUIRED` → 無 sentinel → REVIEW_INCOMPLETE（exit 0）。
   這就是 v0.30.1 修的「exit-0 flaky」的一種具體成因。
   **修法方向（mra 端）**：TTL 調高（如涵蓋整個 review 時長）或改用
   fd-held-open/重連時重供 auth；安全代價小。
2. **PKB-less hang（1 次）**：codex 子進程死亡後 mra **無限等待**（>55 分鐘,
   手動 kill；process tree 存活但 log 凍結）。PMK 的 10-min runMraReview
   timeout 是唯一防線；**mra 端應加子進程 watchdog**。

### 未決問題的實測答案

1. ~~stripped env 下 MCP 可達性~~ → **答案是不可達,且與 env 無關**：mra 的
   codex/claude review 用全新 temp HOME（只複製 auth），真實
   `~/.codex/config.toml` / `~/.claude.json` 的 MCP 設定進不去（provider 設定
   是 mra 解析後用 `-c` 旗標轉發的）。**MCP 版整合必須改 mra**；prompt 注入
   版已實測無效益（codex 路徑）。
2. ~~review clone 索引策略~~ → **copy db + `codegraph sync` 驗證可行**：
   主 clone db → PR head 狀態 reconcile（150 檔差異）**5.5 秒**。
3. 多 repo 成本：96MB × N — 未變。
4. 1.x API 穩定度：未變（整合層要薄）。

## 修訂後的下一步

- ❌ **T1（codex review 路徑）**：終止——實測無效益。
- ⏸ **T1（claude 多輪路徑：mra-ask / claude provider / debate）**：假說仍
  成立但未測；要測需改 mra（temp HOME 帶入 MCP config）。價值待
  claude-path 工作負載出現再議。
- ✅ **優先轉向 mra 可靠性修復**（本輪最大產出）：TTL-auth race + hang
  watchdog，兩者都是 production REVIEW_INCOMPLETE 的實錘成因——已開
  [multi-repo-agent#17](https://github.com/hanfour/multi-repo-agent/issues/17)
  （TTL-auth race）與
  [multi-repo-agent#18](https://github.com/hanfour/multi-repo-agent/issues/18)
  （dead-child hang watchdog）。
- ✅ **T2 模式借鏡**照舊有效（staleness banner、measured coverage）。
- ⏸ **T3 doc↔code bridge**：與本輪結果無關，價值獨立，另案評估。
- codegraph 對 **Claude Code 互動開發**（host 上人機協作）仍明確有價值
  （explore 手術刀級），與 review 自動化是兩回事。

## 現狀記錄

- host 已裝 codegraph 1.4.1（npm global）、telemetry off
- `~/OneAD/erp/.codegraph/`（96MB）保留作持久索引
- 未執行 `codegraph install`（未動任何 agent 設定檔）
- A/B 實驗 clone 於 session scratchpad，主 clone `~/OneAD/erp` 全程未動
- PR #4890 零寫入（POST_MODE=none 全程生效）
