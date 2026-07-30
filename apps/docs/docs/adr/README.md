---
sidebar_position: 1
---

# ADR Index

The kit ships three pre-written **methodology** ADRs you can adopt as-is or adapt. These are decisions about _how you work_, not which tech stack you pick.

| # | Title | Status | Date |
|---|---|---|---|
| [ADR-0001](./strangler-fig-protocol) | Strangler Fig migration protocol | Accepted | 2026-04-24 |
| [ADR-0002](./dev-harness) | Dev harness conventions | Accepted | 2026-04-24 |
| [ADR-0003](./product-decision-log) | Product decision log as a first-class ADR class | Accepted | 2026-04-24 |

## Project ADRs

The kit's own architectural + process decisions (write your own starting at 0004+):

| # | Title | Status | Date |
|---|---|---|---|
| [ADR-0004](./desktop-framework) | Desktop app framework — Electron | Accepted | 2026-04-24 |
| [ADR-0005](./pmk-mra-bridge) | pmk delegates code intelligence to mra (does not absorb) | Accepted | 2026-04-27 |
| [ADR-0006](./pmk-gateway-slack) | pmk gateway — host-machine bot for Slack/LINE, not SaaS | Accepted | 2026-04-27 |
| [ADR-0007](./atom-approval-rubric) | Atom approval rubric — strict five-axis gate at proposal time | Accepted | 2026-06-05 |
| [ADR-0008](./gateway-secret-references) | Gateway secret references — `{cmd}`/`{env}` instead of plaintext | Accepted | 2026-06-05 |
| [ADR-0009](./brace-expansion-advisory) | brace-expansion advisory — accept the audit noise, do not override | Accepted | 2026-07-30 |

## How to use

1. Adopt as your repo's starting ADR-0001/0002/0003, or renumber to fit your sequence.
2. Write your own technical ADRs (monorepo choice, backend framework, ORM, etc.) starting at 0004+.
3. Use [`docs/templates/adr-template.md`](../templates/adr-template) for new ADRs.

## How to add an ADR

1. Copy `docs/templates/adr-template.md` to `docs/adr/NNNN-<slug>.md` (next sequential number)
2. Fill in: Status (Proposed initially), Date, Deciders, Tags, Context, Decision, Consequences, Alternatives Considered, References
3. Add a row to this index
4. PR → Architect + senior eng review → merge; change Status to Accepted

## Status lifecycle

`Proposed` → `Accepted` → (`Deprecated` | `Superseded by ADR-XXXX`)

Never delete a deprecated ADR. Keep the trail.
