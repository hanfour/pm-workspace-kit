# Gateway test fixtures

Static data fixtures shared across `gateway-{doctor,dry-run,demo-seed}.test.ts`
(M2 / M3 / M4 of [PLAN-2026-0526-ONBOARDING](../../../../../apps/docs/docs/plans/2026-05-gateway-onboarding-sprint-plan.md)).

This directory complements `test/harness/` — `harness/` holds runtime fakes
(e.g., `slack-fakes.ts`); `__fixtures__/gateway/` holds static input data
(fake tokens, mra workspace trees, seed-atom JSON, etc.) that the harness
fakes consume.

Add new files as milestones land:

- `M2` (doctor): expected/actual token-response payloads for `auth.test`.
- `M3` (dry-run): stub event payloads that exercise the retrieval →
  escalation path without real Slack traffic.
- `M4` (demo seed): the canonical seed-atom JSON written by
  `pmk gateway demo seed`.

No fixture should contain real credentials. Pattern: `xoxb-test-...` /
`xapp-test-...` and obviously synthetic IDs (`Utest-...`, `Ctest-...`).
