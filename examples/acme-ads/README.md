# AcmeAds — Worked Example

Fictional ad-tech company demonstrating the kit end-to-end. Read the companion [docs page](../../docs/examples/acme-ads.md) for context.

## Files

| File | Shows |
|---|---|
| `ontology/systems/crm.yaml` | Ontology YAML shape: entities, fields, associations, PII tiers, business rules |
| `docs/prds/2026-Q2-customer-onboarding-prd.md` | PRD front-matter in practice; cites REQ / ADR / module |
| `docs/architecture/modules/crm-customer-migration.md` | Full 12-section module playbook with module-specific overrides |
| `docs/adr/0004-go-monolith.md` | Sample **technical** ADR (after the 0001-0003 methodology ADRs) |
| `docs/prds/2026-Q2-placement-dashboard-prd.md` | PRD-2026-0002 — placement performance dashboard (vCPM / PlacementRevenue) |
| `docs/prds/2026-Q2-onboarding-dedup-prd.md` | PRD-2026-0003 — customer dedup for self-service onboarding |

## Running traceability against this example

`--cwd` ships today, so you can check this example directly:

```bash
node packages/core/src/traceability.js check --cwd=examples/acme-ads
```

The repo's `npm run traceability:check` still targets `apps/docs` only, so the
example is validated via the explicit `--cwd` invocation above.

> Gateway demo atoms for this example are **not** files here — they live in the
> CLI seed module `packages/cli/src/gateway/acme-ads-seed.ts` (`seedAcmeAdsAtoms()`).

## Not real companies

"AcmeAds" is the textbook fictional-company name from cryptography and economics papers. Any resemblance to a real ad-tech company is coincidence.
