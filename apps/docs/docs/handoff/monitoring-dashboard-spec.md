---
sidebar_position: 5
---

# Monitoring Dashboard Spec

Every migrating module gets a dashboard with the same six blocks. Implementation (Datadog / Grafana / Vercel Analytics / stack-of-choice) is flexible; the panel layout is not.

## Header

- **Module**: `<domain.module_id>`
- **Current migration stage**: read from feature flag
- **Owner + on-call**: `<link>`
- **Last incident**: `<date + severity>`

## Block A — Health (RED)

1. **Request rate** per minute, split by `method × status_group`
2. **Error rate** (% 5xx), SLO line: < 0.5%
3. **Latency** (p50 / p95 / p99), SLO line: module's specified target

## Block B — Business KPIs (module-specific)

Tie these back to the module's success metrics in its playbook § 11. Typical examples:
- Entity create / update rate
- Pending / failed records
- Throughput for the module's main business event

Each KPI panel in Block B should have a counterpart in the module playbook — no dashboard metric without a documented target.

## Block C — Migration (Stage 1–3 only)

1. **Reconciliation diff rate** over 24h, SLO line from module playbook
2. **Dual-write lag** (new side behind old, seconds)
3. **Stage card**: current stage, entered at, exit-threshold progress
4. **Rollback drill**: last rehearsal date

## Block D — AI / Agent

1. **Tool call rate** by tool name
2. **HITL checkpoints**: count pending + avg wait
3. **LLM cost**: hourly $ + cumulative day
4. **Cache hit rate**: prompt caching
5. **Eval regression pass rate**: latest PR + daily scheduled

## Block E — Dependencies

1. External API response rate / latency
2. Upstream event consume lag
3. Downstream event delivery success

## Block F — Data Quality

1. Ontology drift alerts (last 24h)
2. Data integrity (e.g. `budget IS NULL` row count)
3. Audit log write rate — should equal mutation rate

## Alerts (mandatory set)

| Name | Trigger | Severity | Notify |
|---|---|---|---|
| `<module>.error_rate_high` | > 0.5% for 5m | P2 | Slack `#<module>-alerts` |
| `<module>.latency_p95_high` | > SLO × 1.5 for 10m | P2 | Slack |
| `<module>.recon_diff_high` | > SLO for 30m | **P1** | PagerDuty |
| `<module>.dual_write_lag` | > 5m | P2 | Slack |
| `<module>.hitl_stuck` | pending > 50 or oldest > 4h | P2 | Slack + email |
| `<module>.llm_cost_spike` | hourly > 2× baseline | P2 | Slack + AI team |
| `<module>.eval_regression_fail` | any regression fails | **P1** (merge block) | PR check |

## Deployment checklist

Before a module can enter Stage 0, all of these must be green:

- [ ] Dashboard URL referenced in the module's runbook
- [ ] Block A and Block C show data (even if shadow-mode)
- [ ] At least 3 alerts validated with synthetic triggers
- [ ] On-call rotation points to this dashboard
- [ ] Weekly review meeting agenda includes dashboard walkthrough
