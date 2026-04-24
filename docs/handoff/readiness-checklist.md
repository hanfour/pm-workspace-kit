---
sidebar_position: 6
---

# Sprint 5+ Readiness Checklist

Gate between "we planned" and "we implement". Architect + PM Lead sign off jointly. Items marked ❌ block the kickoff.

## Organizational

- [ ] Engineering owner assigned per module
- [ ] Domain SMEs identified where relevant (finance SME for billing modules, security SME for auth, privacy SME for audience / user data)
- [ ] On-call rotation set up
- [ ] Stakeholders briefed (timeline, possible downtime, scope of change)

## Documentation

- [ ] Module playbook (`docs/architecture/modules/<module>-migration.md`) reviewed and signed
- [ ] Ontology gaps listed, queued for Stage 0
- [ ] Relevant ADRs (0001–0010 range) are Accepted; owners know the rationale
- [ ] Module runbook skeleton in place (copy of handoff template)

## Infrastructure

- [ ] Monorepo scaffold exists (apps + packages as planned)
- [ ] Core packages (`ontology`, `db`, `contracts`, `harness`) have hello-world in staging
- [ ] `apps/web`, `apps/api`, `apps/agent`, `apps/worker` each deployable to staging
- [ ] CI pipeline 10 steps all green on main: install / lint / typecheck / ontology validate / unit / integration / eval / build / traceability / bundle-size
- [ ] Traceability workflow enabled on the implementation repo
- [ ] Feature-flag system runnable: `migration.<module>.mode` togglable from dashboard

## Platform capability

- [ ] SSO in staging — login works end-to-end
- [ ] Postgres, Redis, queue service deployed to staging
- [ ] LLM gateway reachable — can call at least two providers
- [ ] Distributed tracing bridges web → api → db
- [ ] Audit log writes succeed and are queryable
- [ ] Dashboard platform configured — template can be instantiated per module

## Migration tooling

- [ ] Bridge infrastructure (old ↔ new event forward) exists
- [ ] Reconciliation script template (`scripts/reconcile-<module>.ts`) reviewed
- [ ] `reconciliation_diffs` table created
- [ ] Rollback procedure rehearsed at least once on a dummy module

## Security & compliance

- [ ] Security review passed — PII tier tagging, authorization policies, secrets handling all sound
- [ ] Privacy impact assessment (PIA) done for modules touching personal data
- [ ] Regulatory / tax / legal review for modules where applicable (invoices, customer contracts, etc.)
- [ ] Incident response playbook in place

## Per-module Stage 0 gate (repeat per module)

When a specific module is about to enter Stage 0, additionally:

- [ ] Every item in module playbook § 9 Stage 0 checklist is actionable
- [ ] Upstream module dependencies are at least in Stage 2 (or being migrated in parallel)
- [ ] Change-freeze declared if the module is parameter-heavy or widely-read (e.g. products, user roles)
- [ ] Module dashboard deployed; Block A and Block C panels have at least shadow-mode data
- [ ] Module runbook sections 2.1–2.4 (four default incident playbooks) filled in

## Sign-off

| Role | Name | Date |
|---|---|---|
| Architect | | |
| PM Lead | | |
| Engineering Owner | | |
| On-call Lead | | |
| Security SME | | |
| Business / Domain SME | | |

---

Anything still unchecked is a Sprint 5 blocker. "We'll fix it in Sprint 6" is how production incidents get planned.
