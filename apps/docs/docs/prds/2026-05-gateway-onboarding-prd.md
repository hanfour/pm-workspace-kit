---
doc_id: PRD-2026-0006
title: pmk gateway — 30 分鐘 host onboarding
owner: "@hanfourhuang"
status: Draft
date: 2026-05-26
related:
  requirement: []
  plan:
    - docs/plans/2026-05-product-priorities-plan.md
  spec: []
  architecture: []
  adr:
    - ADR-0006
  module:
    - packages.cli
  confluence_page_id: null
---

# pmk gateway — 30 分鐘 host onboarding

## 1. Executive Summary

PRD-2026-0005（gateway slack PRD）證明了 Slack 是非 CLI stakeholder 的
正確入口；落地之後的痛點換了一條：**host 自己拉起 gateway 的門檻仍重**。
今天 `pmk gateway init` 已把 5 個 Slack scope / event subscription 印在
螢幕上要 host 手動點完，但沒有 manifest、沒有預檢、沒有 dry-run；任何
一個 token / scope / mra workspace / Anthropic key 弄錯，都是在第一次
真的有人 @bot 時才會炸。

這份 PRD 把目標縮成一句：**乾淨機器上、不讀 source code、30 分鐘內
host 能讓 gateway 回完一個訊息**。對應
[2026-05 product priorities plan](../plans/2026-05-product-priorities-plan.md)
的 P1，是放在 brief `apps/docs/docs/_briefs/2026-05-product-narrative-brief.md`
（repo-only，未發佈在 Docusaurus）R2 之前的最大槓桿。

## 2. Problem Definition

### Current pain

- **Slack app 設定靠人眼複製**：`gateway.ts:118-146` 把 5 個 OAuth scope、
  3 個 event subscription 印成文字，host 必須一條一條去 api.slack.com 點
  完。任一條漏掉，要等到 runtime 才會出現 `missing_scope` 錯誤。
- **沒有預檢**：`gateway init` 寫完 `~/.pmk/gateway.json` 後直接結束，
  不檢查 token 是否能登入、Anthropic key 是否生效、mra workspace 是否
  存在、PKB 是否有任何 ingestible 內容。
- **沒有 dry-run**：第一次驗證 = 真的開 socket、真的有人在 channel
  @bot；錯了之後 stakeholder 看到的就是 bot 在 channel 裡沉默或丟錯。
  Host 不敢拿 production channel 試，於是停留在「弄好但不敢推給人用」
  的灰色地帶。
- **沒有 smoke-test seed**：host 想驗 retrieval → atom → escalation
  整條鏈，必須自己 seed atom，靠 `gateway atoms add` 手刻；新 host
  沒有信心知道 atom schema 長怎樣。

### Desired outcome

| 階段 | 從 | 到 |
|---|---|---|
| Slack app 設定 | 手動點 5 個 scope + 3 個 event | 上傳 1 份 manifest JSON |
| Token / env 驗證 | runtime 才知道有沒有錯 | `pmk gateway doctor` 一次列出所有失敗 |
| 第一次驗證 | 用 production channel + 真人 @bot | `pmk gateway start --dry-run` 全程不發訊息 |
| Seed 知識 | 自己手刻 atom | `pmk gateway demo seed` 寫入 1 顆已知能被 retrieval 命中的 atom |

## 3. Goals & Success Metrics

### Goals

- **G1**：乾淨機器上，host 從 `git clone` 到「@bot 收到第一個回覆」≤ 30 分鐘。
- **G2**：所有可預先驗證的失敗模式都在 runtime 之前被 `gateway doctor` 攔下。
- **G3**：Host 在不發任何訊息到 Slack 的前提下，可以重現整條 retrieval →
  LLM → escalation 路徑。
- **G4**：新 host 不必讀 source code、不必查 README 以外的文件。

### Metrics

| Metric | 量法 | 目標 |
|---|---|---|
| Time-to-first-message | 從 `git clone` 計時，到 host 自己 @bot 收到回覆 | ≤ 30 min（baseline 後設目標） |
| Doctor coverage | 已知 runtime failure 在 doctor 中有 check 的比例 | 100%（每次新 failure mode 都補 check） |
| Dry-run 真實度 | dry-run 跑過後，再切真實模式時新增的 surprise failure 數 | 0（每多 1 個 = doctor 漏） |

Baseline 由 P1 第一輪內部 host 計時取得；目標數字在 baseline 量到後填入。

## 4. Non-Goals

- **不做 hosted / SaaS**：與 ADR-0006 host-run 模型衝突，永遠不在 scope。
- **不讓 mra 變 optional**：base value 與 mra-enhanced value 的分流在 P3
  做（`intro.md` 改寫），不在這份 PRD。
- **不做 polished AcmeAds demo bundle**：那是 plan P5。本 PRD 的
  smoke-test seed 只要 1 channel + 1 atom 能讓 host 自驗，**不**做
  guided walkthrough、不做多份 seed PRD。
- **不擴 Slack OAuth 分發**：仍走 Socket Mode + 單一 workspace 安裝。
- **不做 doctor 自動修復**：doctor 只診斷、不寫入；修復路徑由人類執行。

## 5. User Stories

### US1 — 第一次裝（primary）

> 作為一個剛 clone repo 的 engineer-PM，我想在 30 分鐘內讓 gateway
> 在我自己的 Slack workspace 回得出 @bot 的問題，這樣我才有信心
> 推給同事用。

### US2 — 升級到下一版本

> 作為已經跑著 gateway 的 host，我希望 `pmk gateway doctor` 在每次
> 升級後跑一次，就能告訴我有沒有新的環境要求被加進來（新 scope、
> 新 env、新 config 欄位）。

### US3 — Demo / 示範

> 作為要向團隊示範 gateway 的 host，我希望在不污染 production channel
> 的前提下，把整條 retrieval → atom → escalation 鏈跑給人看；dry-run
> 模式就是給這個用的。

### US4 — 拒絕的 stories（明示）

- ❌「我希望 doctor 幫我自動申請 Slack token」— OAuth 分發不在 scope。
- ❌「我希望 gateway 自己幫我裝 mra」— mra 安裝由 mra 自己負責；
  gateway 只負責檢查它存在。

## 6. Functional Requirements

### FR1 — Slack app manifest

- 在倉內提供 `packages/cli/src/gateway/slack/manifest.template.json`：
  - bot scopes：`app_mentions:read`, `chat:write`, `im:history`, `im:read`,
    `im:write`, `users:read`, `reactions:read`
  - event subscriptions：`message.im`, `app_mention`, `reaction_added`
  - socket mode：`true`
  - app-level token scope：`connections:write`
- `pmk gateway init` 第一步改成印 manifest URL 與貼上路徑，**不再**逐條
  唸 scope。
- Manifest 版本資訊維護在
  `packages/cli/src/gateway/slack/manifest-version.ts` 的 `MANIFEST_VERSION`
  常數（**不**寫入 manifest JSON，避免污染 Slack manifest schema 帶來
  上傳失敗風險）；doctor 與 `expectedScopes()` 共用該常數。未來新增
  scope 時在同一個 PR 內 bump 它。

### FR2 — `pmk gateway doctor`

新增 subcommand。最少涵蓋以下 check，每項輸出 `[PASS] | [WARN] | [FAIL]`
+ 一行 hint：

| Check | 失敗時 hint |
|---|---|
| `~/.pmk/gateway.json` 存在且 mode 0600 | `run: pmk gateway init` |
| App-Level Token (`xapp-...`) auth 通 | `regenerate at api.slack.com/apps/.../general` |
| Bot Token (`xoxb-...`) auth 通 + scopes 齊全 | 印出缺的 scope 名單 |
| Anthropic API key 可呼叫一次 cheapest 模型 | `check ANTHROPIC_API_KEY env or ~/.pmk/gateway.json` |
| mra workspace 路徑存在且能列 repos | `set mraWorkspace in gateway.json` |
| PKB 有 ≥ 1 個 ingestible 來源（mra 或 `defaultIngest`） | `pmk ingest mra:--all` |
| Channel ACL 設定（至少 1 個 allowed channel 或明確 allow-DM） | `pmk gateway audience set ...` |
| Manifest 版本與倉內 template 對齊 | 印出新增的 scope 名單 |

實作要點：
- 純 read-only，**不**寫入任何檔案、**不**發訊息到 Slack。
- Exit code：全 PASS → 0；任一 FAIL → 1；只有 WARN → 0。
- 可以 `pmk gateway doctor --json` 給 CI / hook 用。

### FR3 — `pmk gateway start --dry-run`

- 啟動完整 socket，但接到 event 時：
  - 走完 atom retrieval + LLM 呼叫 + escalation decision 邏輯。
  - 任何 `chat.postMessage` / `chat.postEphemeral` / `reactions.add`
    都被 stub 成 console 印出 payload 摘要，**不發到 Slack**。
- Dry-run 期間 events 仍寫進 `events-YYYY-MM.log`，但檔名前綴 `dryrun-`，
  避免污染真實 audit。
- 結束 dry-run（Ctrl+C）時印出本次 session 的 retrieval hit rate、LLM
  token 用量、escalation 觸發次數。
- 對使用者的提示：`pmk gateway start --dry-run` 啟動時印一個明顯 banner，
  避免誤以為在真實模式。

### FR4 — Smoke-test seed

- 新 subcommand：`pmk gateway demo seed`
  - 寫入 1 顆 seed atom：`atoms/seed-onboarding-check.json`，內容是
    「pmk gateway 是什麼」這類保證會被 retrieval 命中的 Q&A。
  - 寫入 1 個 demo channel allowlist：`demo-onboarding`（或當前
    `default` channel，依 host 選擇）。
  - 印一句建議訊息：「請在 Slack 對 #demo-onboarding 發問
    『pmk gateway 是什麼？』」。
- 故意**不**寫多顆 atom、**不**寫 PRD seed、**不**寫 walkthrough。
  這些是 P5 demo bundle 的工作。
- `pmk gateway demo unseed` 對稱清掉。

### FR5 — Onboarding 文件

- `apps/docs/docs/gateway/onboarding.md` 新檔：
  - 30 分鐘的時序：manifest 上傳 (5 min) → tokens (5 min) → `gateway init`
    (5 min) → `gateway doctor` (5 min) → `gateway demo seed` + `start
    --dry-run` (5 min) → 切真實 + 第一個訊息 (5 min)。
  - 與 README 採用路徑（Day 1 / Day 2 / Week 1 / Week 2）的 Week 1
    段落 cross-link。
- README.md 對應段落同步更新，但**該段內容變動限縮**為加上 manifest 路徑、
  doctor 與 dry-run 兩個新 verb；不重寫整節（避免與 P3 衝突）。

## 7. Risks

### Risk 1 — Manifest 版本與 Slack API 變動脫節

Slack 端新增 scope / event 時，倉內 manifest template 可能滯後，新 host
拿舊 template 上傳會缺新功能（如 reaction-based approval）。
**緩解：** doctor 中加入 manifest 版本對齊檢查（FR2 最後一項）；
每次新增 scope 時，**同一個 PR** 改 manifest template + bump
`MANIFEST_VERSION`（在 `manifest-version.ts`）+ 更新 doctor 的
expected scope 清單。

### Risk 2 — Doctor 變成「假安心」

如果 doctor 漏一個 runtime failure mode，host 看到 [PASS] 就以為穩了，
之後在 production 還是炸。
**緩解：** Metric 3（dry-run 真實度）就是在量這件事；每次新 failure mode
被回報，doctor 必須補 check 才能 close issue。

### Risk 3 — Dry-run 邊界錯誤

如果 dry-run 不小心真的發了訊息（譬如忘記 stub 某個 reaction），會直接
污染 production channel。
**緩解：** dry-run 模式下，**最外層** Slack client 包裝直接攔截所有
寫操作；不是各 caller 各自記得跳過。違反 immutability 原則的 caller
不該存在。

### Risk 4 — 30 分鐘目標太樂觀

對 Slack 完全沒摸過的 host，光是註冊 app + 找 Socket Mode 開關就可能
超過 5 分鐘。
**緩解：** Time-to-first-message 量到 baseline 後，如果中位數 > 30 min，
先檢視是 Slack 端教學不夠細，還是 pmk 端有可移除的步驟；不要為了硬達
30 min 而省 doctor 檢查。

## 8. Open Questions

1. **Manifest 是放倉內還是放成 GitHub Pages?**
   倉內：版本與 source code 綁定，但 host 必須先 `git clone`。
   GitHub Pages：可以直接 `Create from URL` 一鍵裝，但版本管理較鬆。
   **傾向：** 倉內為主，README 提供 raw.githubusercontent URL 給「不想
   clone 就試」的人。

2. **Doctor 要不要含 `claude` CLI auth check？**
   如果 host 走 `claude-agent-sdk` 路徑（v0.12 之前的預設），doctor 要
   驗 `claude` CLI 已登入。但 v0.12 之後 anthropic-api 才是預設，這個
   check 變 conditional。
   **傾向：** 視 `provider` config 而定，conditional check。

3. **`gateway demo seed` 寫入位置**
   寫進真實 `~/.pmk/atoms/` 還是另開 `~/.pmk/demo/` namespace？
   寫進真實會污染 PKB，但分開又要 retrieval 也讀 demo namespace（增加
   特例）。
   **傾向：** 寫真實，但 atom 帶 `source: "demo-seed"` 標籤，audit
   時可一鍵清。`gateway demo unseed` 用這個標籤 reverse。

4. **Dry-run 是否要支援 record + replay？**
   理想上 dry-run 應該能 replay 一段歷史 event log，驗 retrieval 改動
   不會 regress 答題品質。
   **傾向：** 不在本 PRD scope；如果需要再開獨立 PRD（會牽到 atom
   versioning）。

## 9. 出貨檢驗

完成本 PRD 視為 P1 結案的條件：

1. 一位沒看過 source code 的 host（找 1 名內部同事），用 README +
   onboarding.md 完成第一次裝機，計時並記錄 baseline。
2. Doctor 對所有故意製造的失敗（rotate 過期 token、把 mra workspace
   設成不存在路徑、刪掉 PKB 內容、退回舊版 manifest template）都印出
   可操作 hint。
3. Dry-run 跑過整條 retrieval → escalation 路徑，事後在真實模式重跑
   同樣 prompt 沒有 surprise failure。
4. `gateway demo seed` + `unseed` 對稱、不留殘留 atom。

四點全綠 → P1 出貨；任一不過 → 在下一 sprint 補。
