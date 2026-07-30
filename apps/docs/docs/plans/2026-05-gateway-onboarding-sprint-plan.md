---
doc_id: PLAN-2026-0526-ONBOARDING
title: pmk Gateway Onboarding Sprint Plan
owner: "@hanfour"
status: Draft
date: 2026-05-26
related:
  prd:
    - PRD-2026-0006
  adr:
    - ADR-0006
  module:
    - packages.cli
---

# pmk Gateway Onboarding — Sprint Plan

PRD: [PRD-2026-0006](../prds/2026-05-gateway-onboarding-prd)。

兩個 sprint（每個 ~1 週 part-time），共 7 個 milestone。每個 milestone
最後有一個可示範的 deliverable 與 go / no-go gate。M6 是 baseline 量測，
本 sprint plan 結束時 baseline 必須有數，目標值才有依據。

## Conventions

- TDD：寫失敗 test → 跑（FAIL）→ 最小 impl → 跑（PASS）→ commit。
- 單檔測試：`cd packages/cli && node --import tsx --test test/<file>.test.ts`。
- 全套：`npm --workspace packages/cli test`。
- Commit 格式：`<type>(<scope>): <description>`，無 Co-Authored-By。
- 每個 commit 後測試必須綠。
- 不要在個別 task 裡升版號；release commit 由 M6 之後另起。
- 本 sprint 預期落地版本：**v0.16.0**（feature 級 squash-merge PR；見
  [[feedback-release-workflow]]）。
- Branch 建議：`feat/gateway-onboarding-v0.16`。

## File map

| Path | 負責 milestone |
|---|---|
| `packages/cli/src/gateway/slack/manifest.template.json`（新） | M1 |
| `packages/cli/src/gateway/slack/manifest-version.ts`（新） | M1, M2 |
| `packages/cli/src/commands/gateway.ts`（既有，新增 `doctor` / `demo` 分派） | M2, M4 |
| `packages/cli/src/gateway/doctor.ts`（新） | M2 |
| `packages/cli/src/gateway/doctor-checks/*.ts`（新；每個 check 一檔） | M2 |
| `packages/cli/src/gateway/slack/index.ts`（既有，加 dry-run 攔截層） | M3 |
| `packages/cli/src/gateway/slack/dry-run-wrapper.ts`（新） | M3 |
| `packages/cli/src/gateway/demo-seed.ts`（新） | M4 |
| `packages/cli/test/gateway-doctor.test.ts`（新） | M2 |
| `packages/cli/test/gateway-dry-run.test.ts`（新） | M3 |
| `packages/cli/test/gateway-demo-seed.test.ts`（新） | M4 |
| `apps/docs/docs/gateway/onboarding.md`（新） | M5 |
| `apps/docs/docs/gateway/lifecycle.md`（既有，cross-link onboarding） | M5 |
| `apps/docs/docs/changelog.md` | M6 |
| `README.md`（既有，FR5 限縮：補三個新 verb） | M5 |

## M0 — 起手準備（半天）

- [ ] 開 branch `feat/gateway-onboarding-v0.16`，從 `main` 切。
- [ ] 確認 `npm run traceability:check` 通過（PR-58 已建立的 baseline：
      7 primary docs / 8 virtual / 21 edges）。如有不對先修文件再進實作。
- [ ] 在 `packages/cli/test/__fixtures__/gateway/` 開新目錄，準備之後 M2
      / M3 / M4 共用的 fixture（fake Slack token、fake mra workspace tree
      等）。

**Gate**：branch on remote、`traceability:check` 全綠。

## M1 — Slack app manifest（FR1，1.5 天）

- [ ] **Test**（`gateway-manifest.test.ts`）：載入 manifest template、
      assert 包含所需 scope 與 event subscription 三項。
- [ ] **Impl**：`manifest.template.json` 帶入 PRD FR1 列出的全部 scope
      與 events。**不**在 JSON 內加自訂欄位（避免 Slack manifest schema
      reject 上傳）。
- [ ] **Impl**：`manifest-version.ts` 匯出 `MANIFEST_VERSION = "2026-05"`
      與 `expectedScopes()`、`expectedEvents()`，供 M2 doctor 比對。
      版本資訊與 manifest JSON 在同一資料夾、但**不**寫入 manifest 內。
- [ ] **Impl**：`gateway init` 啟動文字改為印 manifest 路徑與
      `https://api.slack.com/apps?new_app=1` 連結，不再逐條唸 scope。
- [ ] **Verify**：手動上傳 manifest 到 api.slack.com 一次，確認 Slack
      端解析成功；截圖貼入 PR。
- [ ] **Commit**：`feat(gateway): ship slack app manifest (FR1)`。

**Gate**：manifest 可被 api.slack.com 接受、`init` 不再列 scope 條目。

## M2 — `pmk gateway doctor`（FR2，2 天）

每個 check 一個 sub-module，方便獨立測試與後續擴充。

- [ ] **Test**（`gateway-doctor.test.ts`）：每個 check 至少一個 PASS、
      一個 FAIL 情境。FAIL 時 exit code 1。`--json` 輸出可被 `JSON.parse`。
- [ ] **Impl**：在 `doctor-checks/` 下各放一個檔：
  - `config-file.ts`：檢查 `~/.pmk/gateway.json` 存在 + mode 0600。
  - `slack-app-token.ts`：呼一次 `auth.test`，驗 App-Level Token。
  - `slack-bot-token.ts`：呼一次 `auth.test`，列出實際 scope 與
        `expectedScopes()` 差集。
  - `anthropic-key.ts`：跑一次 cheapest 模型（`claude-haiku-4-5`）一個
        token 的 echo call；以 1¢ / month 上限預算。
  - `mra-workspace.ts`：路徑存在 + `mra list` 能列出 ≥ 1 repo。
  - `pkb-content.ts`：`mra:--all` ingest 或 `defaultIngest` 結果 ≥ 1 atom 來源。
  - `channel-acl.ts`：至少 1 個 allowed channel 或 `allowDM=true`。
  - `manifest-alignment.ts`：比對 host 端 manifest 版本與倉內 template。
        刻意與 `slack/manifest-version.ts`（常數模組）區隔命名，避免 grep
        / IDE search 兩檔混淆。
- [ ] **Impl**：`doctor.ts` 收集所有 check，按 PASS / WARN / FAIL 分類排序輸出。
- [ ] **Impl**：在 `gateway.ts` 加 `case "doctor": return doctorCmd(rest)`。
- [ ] **Verify**：手動造 4 種失敗（過期 token、刪 mra workspace、空
      PKB、舊版本 manifest），逐項 hint 正確。
- [ ] **Commit**：`feat(gateway): add doctor preflight (FR2)`。

**Gate**：所有 8 個 check 在「正常」與「故意壞」兩條路徑下行為正確；
`--json` 可被外部腳本消費。

## M3 — `gateway start --dry-run`（FR3，1.5 天）

最關鍵：dry-run 不能漏寫操作。所以攔截要在**最外層 Slack client wrapper**，
不是每個 caller 各自記得跳過。

- [ ] **Test**（`gateway-dry-run.test.ts`）：注入 fake Slack client；
      assert dry-run mode 下任何 `chat.postMessage` / `chat.postEphemeral`
      / `reactions.add` 都被攔截、印 stub log、未呼到底層 client。
- [ ] **Impl**：`dry-run-wrapper.ts` 包一個 `WebClient` proxy；當
      `process.env.PMK_DRY_RUN === "1"` 或 CLI flag 傳入時，所有寫操作
      改成 console + 不送網路請求。
- [ ] **Impl**：`gateway start` 加 `--dry-run` flag；啟動時印一個大
      banner、`events-YYYY-MM.log` 改寫到 `dryrun-events-YYYY-MM.log`。
- [ ] **Impl**：Ctrl+C 時印本次 session metrics：retrieval hit、LLM
      token 用量、escalation 觸發次數。
- [ ] **Verify**：在自己 Slack workspace 跑 `--dry-run`，發訊息觸發路徑，
      確認 Slack 端**沒有任何**新訊息／reaction 出現。
- [ ] **Commit**：`feat(gateway): add --dry-run mode to start (FR3)`。

**Gate**：dry-run 跑過完整 retrieval → escalation 路徑後，Slack 端零副作用；
切回真實模式同樣 prompt 不能 surprise fail。

## M4 — Smoke-test seed（FR4，半天）

- [ ] **Test**（`gateway-demo-seed.test.ts`）：seed 後存在 1 顆 atom，
      標籤含 `source: "demo-seed"`；unseed 後該 atom 消失，其他 atom 不動。
- [ ] **Impl**：`demo-seed.ts` 提供 `seed()` / `unseed()`：
      atom 內容是「pmk gateway 是什麼？」的標準答案；channel allowlist
      新增 `demo-onboarding`（如已存在 default 則加註而非取代）。
- [ ] **Impl**：在 `gateway.ts` 加 `case "demo": return demoCmd(rest)`，
      支援 `seed` / `unseed` 兩個動作。
- [ ] **Verify**：seed → 在 #demo-onboarding 問「pmk gateway 是什麼」→
      bot 回 seed atom 內容；unseed → atom 不見、retrieval 不再命中。
- [ ] **Commit**：`feat(gateway): smoke-test demo seed (FR4)`。

**Gate**：seed / unseed 對稱、無殘留；smoke 測試覆蓋整條 retrieval 鏈
（不含 escalation，escalation 留給未來的 polished demo bundle = P5）。

## M5 — Onboarding 文件 + README 補充（FR5，1 天）

- [ ] **Doc**：`apps/docs/docs/gateway/onboarding.md`：
  - 30 分鐘時序：manifest (5) → tokens (5) → init (5) → doctor (5) →
        demo seed + dry-run (5) → 切真實 + 第一訊息 (5)。
  - 與 README、`gateway/lifecycle.md` 雙向 cross-link。
- [ ] **Doc**：`README.md` 第 B 區（CLI gateway 段）插入三個新 verb：
      `gateway doctor`、`gateway start --dry-run`、`gateway demo seed`。
      **不**改節結構、**不**重寫 Quick start；P3 結構性重寫已隨 PR-58
      （與本 sprint plan 同 PR）落地，到 v0.16 實作時 main 上已有新結構。
- [ ] **Doc**：`gateway/lifecycle.md` 在「初次設定」段加 cross-link 到
      onboarding.md。
- [ ] **Doc**：sidebar 在 Gateway 分類加 `gateway/onboarding`。
- [ ] **Verify**：`npm --workspace apps/docs run build` 通過，沒有新增
      broken-link warning（特別注意：onboarding.md → `_briefs/`
      **不能**用 markdown link，要 backtick path — 見
      [[feedback-docusaurus-briefs-link]]）。
- [ ] **Commit**：`docs(gateway): onboarding guide + README catch-up (FR5)`。

**Gate**：build 綠、sidebar 顯示 onboarding 條目、cross-link 雙向通。

## M6 — Live-host baseline trial（1 天）

不是 milestone-as-feature，是 PRD-2026-0006 第 9 節 quality gate 的執行。

- [ ] 找 1 名沒看過 source code 的內部同事，在乾淨機器上照
      `gateway/onboarding.md` 走完整套，計時。
- [ ] 過程中所有「卡住超過 90 秒」的步驟記錄下來，作為下一輪 doctor /
      文件改進的 input。
- [ ] **故意製造**以下 4 種失敗，確認 doctor 都印出可操作 hint：
      過期 App Token、不存在的 mra workspace、空 PKB、舊版本 manifest。
- [ ] Baseline 數字寫進 PR description 與 changelog：
  - Time-to-first-message（中位數，如果只有 1 人就單點）
  - Doctor 漏接的 failure 數
  - 同事在 onboarding doc 之外問了幾次 / 問了什麼
- [ ] 用 baseline 反過來填 PRD `Goals & Success Metrics` 表的「目標」欄。
- [ ] **Commit**：`docs(release): v0.16 onboarding baseline + metric targets`。

**Gate**：Baseline 在 PR description 有數、PRD metrics 目標欄不再是「baseline 後設」。

## 風險與緩解（sprint 層級）

| Risk | 緩解 |
|---|---|
| Slack 端新增 scope / event 時 manifest 滯後 | M1 引入 `MANIFEST_VERSION`（在 `manifest-version.ts`，**不**在 manifest JSON 內）；M2 doctor 比對 → 不對齊時印 hint。每次新增 scope 必須在**同一 PR** bump 它。 |
| Doctor 變成假安心（漏 check） | M6 trial 強制故意製造 4 種失敗，每次回報新 failure mode 必須補 check 才能 close issue。 |
| Dry-run 漏寫攔截 | M3 在最外層 wrapper 攔，不靠各 caller 自律。違反此原則的 caller 不該存在。 |
| 30 分鐘目標太樂觀 | M6 量到 baseline 後，若中位數 > 30 min，先檢視是 Slack 教學還是 pmk 端可省步驟；**不要**為了硬達 30 min 而省 doctor 檢查。 |

## Out of scope（明示）

- Polished AcmeAds demo bundle — 是 priorities plan 的 P5，不是這個
  sprint 做的事。M4 只做 smoke-test seed。
- Atom quality rubric / telemetry — priorities plan P2，要等本 sprint 跑
  過 baseline 後啟動。
- `intro.md` / README 結構性重寫 — priorities plan P3，本 PR 已併入處理；
  本 sprint 內**不再動** README 結構。
- Doctor 自動修復（auto-fix mode）— PRD 4 段明示不在 scope，永遠 read-only。
