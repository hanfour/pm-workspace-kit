---
sidebar_position: 5
---

# Monitoring Dashboard 規格

每個遷移中模組拿到相同 6 個 block 的 dashboard。實作（Datadog / Grafana / Vercel Analytics）可彈性；版面不可。

## 標頭

- **Module**: `<domain.module_id>`
- **現階段**：從 feature flag 讀
- **Owner + on-call**：`<連結>`
- **最近事故**：`<日期 + severity>`

## Block A — Health（RED）

1. **Request rate** per minute，按 `method × status_group` 切
2. **Error rate**（% 5xx），SLO line：< 0.5%
3. **Latency**（p50 / p95 / p99），SLO line 用模組目標

## Block B — Business KPIs（模組特化）

對照模組 playbook §11 成功指標。典型例：
- Entity create / update rate
- Pending / failed 記錄
- 模組主要業務事件 throughput

Block B 每個 panel 對應到 playbook — 沒有無目標的 metric。

## Block C — Migration（Stage 1–3）

1. **對帳差異率** 24h，SLO line 從 playbook
2. **雙寫 lag**（新側落後舊側秒數）
3. **Stage 卡**：目前 stage、進入時間、退出門檻進度
4. **Rollback drill**：上次演練日期

## Block D — AI / Agent

1. **Tool call rate** 按 tool 名
2. **HITL checkpoint**：pending 數 + 平均等待
3. **LLM 成本**：hourly $ + 日累計
4. **Cache hit rate**：prompt caching
5. **Eval regression 通過率**：最新 PR + 每日排程

## Block E — Dependencies

1. 外部 API 回應率 / latency
2. 上游 event 消費 lag
3. 下游 event 投遞成功率

## Block F — Data Quality

1. Ontology drift alert（近 24h）
2. 資料完整性（例：`budget IS NULL` 計數）
3. Audit log 寫入率 — 應等於 mutation 率

## Alert（必設）

| 名稱 | 觸發 | 嚴重度 | 通知 |
|---|---|---|---|
| `<module>.error_rate_high` | > 0.5% × 5m | P2 | Slack |
| `<module>.latency_p95_high` | > SLO × 1.5 × 10m | P2 | Slack |
| `<module>.recon_diff_high` | > SLO × 30m | **P1** | PagerDuty |
| `<module>.dual_write_lag` | > 5m | P2 | Slack |
| `<module>.hitl_stuck` | pending > 50 或最老 > 4h | P2 | Slack + email |
| `<module>.llm_cost_spike` | hourly > 2 倍 baseline | P2 | Slack + AI team |
| `<module>.eval_regression_fail` | 任一 regression fail | **P1**（擋 merge） | PR check |

## 部署 checklist

模組 Stage 0 前全綠：

- [ ] Dashboard URL 在 runbook 中可點
- [ ] Block A 與 Block C 有資料（即使 shadow mode）
- [ ] 至少 3 條 alert 已 synthetic 觸發驗證
- [ ] On-call 排班指向本 dashboard
- [ ] 每週 review 議程含 dashboard walkthrough
