# Brief — pmk 產品敘事重整（2026-05）

## 為什麼寫這份

v0.13.x audience tiers、v0.14 SlackAdapter Tranche 4、v0.15 audience domains
依序落地之後，產品的重心已經明顯往 Slack gateway 移動。這份 brief 用來：

1. 對齊 `intro.md` 對外講的「三個 surface」與實際投入方向。
2. 收斂主敘事到一條最有差異化的線。
3. 把先前的風險清單補上一個會比 retrieval 品質更早爆掉的失敗模式。

## 一句話的產品定位

> PMK 把 PM 文件、code intelligence、人類專家回答，收斂成可追蹤的知識迴路，
> 給 code-aware 的小團隊用。

## Surface：從五個收斂到三個

先前討論列了五層（Docs+Traceability、CLI、Gateway、Desktop、mra）。從使用者
心智看，這是 over-count。

- **Local doc/code workflow** — `pmk` CLI verbs、`docs/` schema、
  `traceability.js`、ADR / handoff / migration 模板。Traceability 是這個
  surface 的 feature，不是獨立 surface；CLI 是 delivery 機制。
- **Slack gateway** — 非 CLI 使用者的入口。Atom retrieval → mra-ask →
  human escalation → absorb → approval → future retrieval。目前實作最完整、
  也是最有辨識度的 surface。
- **Desktop** — 早期殼層，author / stakeholder 兩模式已有，但與 PRD 描述
  落差大。在文件中視為 secondary，等 Gateway 迴路成熟再回來。

mra 是 *integration*，不是 surface。沒有 mra，base value 仍在（文件 / RAG
/ 模板）；有 mra，產品才升級為 code-aware PM workflow。兩種敘事必須在
positioning 裡分開講。

## 目標使用者（不變動）

- **Engineer-PM / SA / staff engineer** — 主要 ICP，已經在 Git、ADR、
  migration plan 裡生活的人。
- **平台遷移 / 大型重構團隊** — traceability、Strangler Fig、handoff 模板
  的回報最快。
- **非工程 stakeholder** — *不是* CLI 使用者，只透過 Gateway 接觸。
- **小團隊 / 內部工具團隊** — 能接受 host-run、local-first、非 SaaS 部署。

## 最強的優勢

- **方法論閉環**：schema → RAG → Slack Q&A → human escalation →
  atom approval → reuse。多數競品停在「模板」或「retrieval」，PMK 的閉環
  本身才是差異化來源。
- **層次化採用路徑**：模板 → CLI → Gateway，README 已經這樣排。
- 差異化是「整套迴路」，不是任何單一 feature。

## 風險（修訂）

### R1 — Surface 數量超過實際成熟度
外面講五個、實際有價值的三個、其中一個（Desktop）還是 showcase。
對外文件若把 Desktop 放在跟 Gateway 同等位置，會拉低第一印象。
**緩解：** 在 `intro.md` 與 README 中把 Desktop 降級為 secondary，
直到 PRD parity 達成。

### R2 — Host onboarding 仍重
Gateway 降低的是 stakeholder 門檻，不是 host 門檻。Host 仍要會 Slack
app token、mra workspace、Anthropic key、admin bootstrap。對 early
adopter 合理，對「一般 PM 自行導入」不夠。**緩解：** 見計畫 P1。

### R3 — mra 缺席時的 value cliff
有 mra 時是 code-aware PM assistant；沒有 mra 時是 docs / RAG / 模板
工具。兩個產品共用同一個名字。**緩解：** 對外訊息必須清楚分
*base value* 與 *mra-enhanced value*。

### R4 — Knowledge atom 品質是會先爆的失敗模式（先前未列）
Gateway 迴路 absorb → approval → future retrieval 一旦審核被橡皮章化，
PKB 會被 low-signal atom 污染；未來 retrieval 的 precision 會被吃掉。
這個失敗模式會早於「BM25 不夠精準」出現，且不可逆。**緩解：**
approver rubric、atom reuse-rate 計量、季度 atom audit。見計畫 P2。

### R5 — 輕量 RAG vs. 對外訊息
`packages/rag` 用 markdown chunk + BM25，不是 embedding。對 local /
cheap / explainable 是對的選擇，但對外不能寫「高精度知識搜尋」。
**緩解：** positioning 維持「retrieval over your repo docs」，不講
「vector knowledge search」。

## 導入成功路徑（順序修正）

先前版本把 traceability 放 Day 1。但 Day 1 的使用者沒有文件存量，
traceability 看不到價值。改成：

- **Day 1** — `pmk propose` 產一份真的 PRD 進 `docs/prds/`。當天有產出感。
- **Day 2–3** — 寫第二份 PRD，`traceability.js` 開始有連結可驗，
  traceability 的價值出現。
- **Week 1** — 對單一 channel 拉起 Gateway，設定 `defaultIngest=mra:--all`；demo 需要的 seed atoms 另行準備。
- **Week 2** — 知識迴路第一次從頭跑到尾：ask → mra-ask → escalation →
  absorb → reuse。

## 結論

主敘事固定成：**PMK = traceable PM docs + Slack knowledge loop for
code-aware teams**。其餘是 supporting。Desktop 之後它本身夠強再講；
現在拉它上來只會稀釋這條已經 working 的線。

對應的 priorities 計畫見
[plans/2026-05-product-priorities-plan.md](../plans/2026-05-product-priorities-plan.md)。
