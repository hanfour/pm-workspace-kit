---
sidebar_position: 1
---

# Example: AcmeAds

A fictional ad-tech company using the kit end-to-end. Shows what a real workspace looks like after adopting traceability + ADRs + module playbooks. All names and data are invented; the shape of the documents is realistic.

## The setup

**AcmeAds** is a programmatic advertising platform. They're migrating from a Python monolith (5-year-old Flask app) to a TypeScript service-oriented system. Their ERP-like domain has four core modules: `crm`, `billing`, `campaigns`, `reporting`.

## What's in the example

Under [`examples/acme-ads/`](https://github.com/hanfourhuang/pm-workspace-kit/tree/main/examples/acme-ads) in the repo:

```
examples/acme-ads/
├── README.md
├── ontology/
│   └── systems/
│       └── crm.yaml              # 3 entities: Customer, Contract, Contact
├── docs/
│   ├── prds/
│   │   └── 2026-Q2-customer-onboarding-prd.md
│   ├── architecture/
│   │   └── modules/
│   │       └── crm-customer-migration.md
│   └── adr/
│       └── 0004-go-monolith.md    # tech ADR for this project
```

## What to look at first

### 1. The PRD with real front-matter

[`docs/prds/2026-Q2-customer-onboarding-prd.md`](https://github.com/hanfourhuang/pm-workspace-kit/tree/main/examples/acme-ads/docs/prds/2026-Q2-customer-onboarding-prd.md) shows a PRD that:

- Uses the required `doc_id`, `related.requirement`, `related.module` fields
- Cites an ADR (`ADR-0004`) that drives the technical direction
- Ties back to a specific module (`crm.customer`) that has its own playbook

Run `npm run traceability:matrix` against the example directory to see the graph.

### 2. The module playbook in context

[`docs/architecture/modules/crm-customer-migration.md`](https://github.com/hanfourhuang/pm-workspace-kit/tree/main/examples/acme-ads/docs/architecture/modules/crm-customer-migration.md) fills in the 12-section template for the `crm.customer` module. Note:

- The dependency diagram links to the neighboring modules (`billing`, `campaigns`)
- Stage 0 checklist items are concrete (ontology gap, migration script, feature flag)
- Risks are tagged with likelihood × impact, not vague prose
- Module-specific override: customer data is PII-sensitive → reconciliation tolerance tightened 5× vs default

### 3. The tech ADR

[`docs/adr/0004-go-monolith.md`](https://github.com/hanfourhuang/pm-workspace-kit/tree/main/examples/acme-ads/docs/adr/0004-go-monolith.md) is a sample **technical** ADR (following the 0001–0003 methodology ones). Shows the shape of an ADR where the Deciders, Alternatives, and Consequences are fully spelled out.

### 4. The ontology

[`ontology/systems/crm.yaml`](https://github.com/hanfourhuang/pm-workspace-kit/tree/main/examples/acme-ads/ontology/systems/crm.yaml) — three entities with fields, associations, PII tiers, and business rules. Small enough to read in one sitting; large enough to show the shape.

## Running the example

```bash
cd examples/acme-ads
# The top-level script scans the kit's docs by default.
# To run it against the example, temporarily adjust SCAN_DIRS in scripts/traceability.js.
```

A future kit version will take a `--cwd` flag so you can point the scripts at any sub-repo without editing them.

## What this example doesn't show

Deliberately omitted to keep it readable:

- A full 10-chapter north-star document (see [Guide: Authoring North Star](../guides/authoring-north-star.md) for the template)
- Monitoring dashboard JSON (platform-specific)
- Confluence sync in action (requires live credentials)
- Multi-module co-migration sequencing (covered conceptually in [Strangler Fig](../concepts/strangler-fig.md))

## When you copy this for your own project

1. Start fresh: the example's `doc_id` sequence is `PRD-2026-0001`, `ADR-0004`. You can re-number to match your project's history.
2. Delete the "acme" names; fill in real ones.
3. The YAML / front-matter shape is the reusable part. The actual fields and business rules are yours.

## Related

- [Getting Started](../getting-started.md) — 10-minute walkthrough
- [Templates: Module Playbook](../templates/module-playbook-template.md) — the blank version
- [Concepts: Traceability](../concepts/traceability.md) — why the front-matter matters
