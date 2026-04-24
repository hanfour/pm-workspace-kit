# AcmeAds — Worked Example

Fictional ad-tech company demonstrating the kit end-to-end. Read the companion [docs page](../../docs/examples/acme-ads.md) for context.

## Files

| File | Shows |
|---|---|
| `ontology/systems/crm.yaml` | Ontology YAML shape: entities, fields, associations, PII tiers, business rules |
| `docs/prds/2026-Q2-customer-onboarding-prd.md` | PRD front-matter in practice; cites REQ / ADR / module |
| `docs/architecture/modules/crm-customer-migration.md` | Full 12-section module playbook with module-specific overrides |
| `docs/adr/0004-go-monolith.md` | Sample **technical** ADR (after the 0001-0003 methodology ADRs) |

## Running traceability against this example

The top-level `scripts/traceability.js` scans the kit's own `docs/` by default. To point it at this example, `cd` into the repo root and edit `SCAN_DIRS` temporarily, or wait for the `--cwd` flag coming in a future release.

## Not real companies

"AcmeAds" is the textbook fictional-company name from cryptography and economics papers. Any resemblance to a real ad-tech company is coincidence.
