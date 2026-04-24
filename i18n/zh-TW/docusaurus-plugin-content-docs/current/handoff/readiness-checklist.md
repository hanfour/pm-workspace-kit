---
sidebar_position: 6
---

# Sprint 5+ Readiness Checklist

「已規劃」到「執行中」之間的 gate。Architect + PM Lead 聯合簽核。❌ 的項目擋 kickoff。

## 組織

- [ ] 每模組指派工程 owner
- [ ] 相關領域 SME 就位（billing 有 finance SME；auth 有 security SME；audience / user 有 privacy SME）
- [ ] On-call 排班就緒
- [ ] 利害關係人 brief（時程、可能停機、變更範圍）

## 文件

- [ ] 模組 playbook（`docs/architecture/modules/<module>-migration.md`）review 並簽核
- [ ] Ontology 缺口列出、排入 Stage 0
- [ ] 相關 ADR（0001–0010）已 Accepted、owner 了解理由
- [ ] 模組 runbook 骨架就位（複製 handoff 模板）

## 基礎設施

- [ ] Monorepo scaffold 存在（apps + packages 如規劃）
- [ ] 核心 package（`ontology`、`db`、`contracts`、`harness`）在 staging 有 hello-world
- [ ] `apps/web`、`apps/api`、`apps/agent`、`apps/worker` 各可部署到 staging
- [ ] CI 10 步在 main 全綠：install / lint / typecheck / ontology validate / unit / integration / eval / build / traceability / bundle-size
- [ ] Traceability workflow 在實作 repo 啟用
- [ ] Feature flag 系統可跑：`migration.<module>.mode` 從 dashboard 切

## 平台能力

- [ ] SSO 在 staging 可跑 — 端到端登入 OK
- [ ] Postgres、Redis、queue 在 staging 部署
- [ ] LLM gateway 可達 — 至少可 call 兩個 provider
- [ ] Distributed tracing 貫穿 web → api → db
- [ ] Audit log 寫入成功可查
- [ ] Dashboard 平台設好 — 每模組範本可 instantiate

## 遷移 tooling

- [ ] Bridge 基建（新舊事件 forward）存在
- [ ] 對帳 script 範本（`scripts/reconcile-<module>.ts`）review 過
- [ ] `reconciliation_diffs` 表已建
- [ ] Rollback 程序已演練至少一次（dummy 模組亦可）

## 安全與合規

- [ ] Security review 通過 — PII tier 標記、authz 政策、secret 處理
- [ ] Privacy Impact Assessment（PIA）完成（涉個資模組）
- [ ] 法遵 / 稅務 / 法務 review 完成（適用時）
- [ ] Incident response playbook 就位

## 每模組 Stage 0 gate（逐模組重複）

開始某模組 Stage 0 時額外：

- [ ] 模組 playbook §9 Stage 0 checklist 每項可行動
- [ ] 上游模組依賴至少在 Stage 2（或並行遷移）
- [ ] 變更凍結（若模組是參數型或廣讀型，如 product / user）
- [ ] 模組 dashboard 部署；Block A 與 Block C panel 至少有 shadow 資料
- [ ] 模組 runbook 2.1–2.4（4 個預設 incident playbook）填好

## 簽核

| 角色 | 姓名 | 日期 |
|---|---|---|
| Architect | | |
| PM Lead | | |
| Engineering Owner | | |
| On-call Lead | | |
| Security SME | | |
| Business / Domain SME | | |

---

任何未勾即 Sprint 5 blocker。「Sprint 6 再補」就是生產事故排程法。
