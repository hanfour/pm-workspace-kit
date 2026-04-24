# ADR-0004: Go monolith for core business services

- **Status:** Accepted
- **Date:** 2026-03-12
- **Deciders:** @alex-eng (architect), @jane-pm (PM lead)
- **Tags:** backend, language, architecture

## Context

AcmeAds' Python / Flask monolith handles 15k requests per second at peak, with p99 latency creeping into the 800ms range. Profiling shows GIL-contention and async ergonomics as the main culprits. A rewrite was already on the roadmap; the question is what to rewrite _into_.

The team has 14 backend engineers. Four of them have meaningful Go experience (3+ years production). The rest are strongest in Python or TypeScript. Secondary constraints:

- Regulatory: AcmeAds runs in jurisdictions with data residency rules → single binary deployable to regional VPCs is attractive
- Build / deploy platform is Kubernetes, no lock-in to any language
- ORM preference: hand-rolled SQL + `sqlc` has worked for the Go team on a side service

## Decision

Rewrite core business services as a **Go monolith** using:

- Standard library HTTP server (`net/http` + `chi` router)
- `sqlc` for type-safe SQL against Postgres
- Wire for dependency injection
- `sloghandler` structured logging
- Single binary per deploy target (regional builds via Docker multi-arch)

Module boundaries follow the kit's recommended DDD approach: `internal/<bounded-context>/...` with explicit cross-context interaction through event bus or API calls, not direct function calls.

## Consequences

### Positive

- Single binary: deploy, debug, regional redeploy all simpler
- Go's concurrency model maps naturally to per-request isolation; no GIL contention
- `sqlc` keeps business logic close to the SQL that touches Postgres — easier for the team's SQL-fluent reviewers
- Build times short enough for pre-commit full test runs (~8s on CI)
- Single language reduces polyglot tax on ops tooling, log shippers, observability SDKs

### Negative

- Rest of team (10 / 14) need Go training — 2–3 weeks ramp per engineer, realistically 1 quarter before fluency
- Generics-light codebase means some patterns from TS / Python don't translate; some repetition
- Monolith deployment blast radius is bigger than per-service deploys. Offset with feature flags.
- Hiring pool narrower than Python + TS combined

### Neutral

- Go's lack of an opinionated framework (vs. Rails / Nest) means style discipline is on the team
- CI cache for Go modules needs explicit tuning
- Logging / tracing SDKs for Go are fine but less polished than Node ecosystem

## Alternatives Considered

### Alternative A: Stay on Python, adopt async (FastAPI + asyncio)

- **Pros**: no migration; team already fluent; modern async works well
- **Cons**: GIL still caps scaling per-process; multi-process deploys complicated; the monolith's current tech-debt remains
- **Rejected**: the current bottlenecks are not primarily "we didn't use async enough" — they're coupling and I/O blocking on external services. Async helps but doesn't address structure.

### Alternative B: Rewrite in TypeScript (Node.js + NestJS)

- **Pros**: largest team member familiarity; ecosystem depth; good async ergonomics
- **Cons**: single-threaded event loop at scale requires multi-process; Nest's decorator-heavy style is controversial; types at the DB boundary are weaker than `sqlc`
- **Rejected**: Go benefits more than TS at the deploy / concurrency layer, and `sqlc` type safety beats the TypeScript ORM options the team has experience with.

### Alternative C: Rewrite in Rust

- **Pros**: maximum performance; compile-time safety exceptional
- **Cons**: only 1 engineer on the team has Rust experience; 6–12 month productivity hit during ramp; hiring is substantially harder
- **Rejected**: productivity loss during migration would delay by ~2 quarters.

### Alternative D: Microservices in any language, per-service optimized

- **Pros**: right tool for each job
- **Cons**: service count → ops overhead; cross-service coordination + tracing becomes primary concern; regulatory data-residency harder with many services
- **Rejected for now**: monolith first, extract services only when a clear boundary proves itself. See ADR-0001 Strangler Fig for the migration pattern we'll apply as the code-base matures.

## References

- [ADR-0001](../../../../docs/adr/0001-strangler-fig-protocol.md) — Strangler Fig migration protocol (adopted)
- [`ontology/systems/crm.yaml`](../../ontology/systems/crm.yaml) — CRM ontology that this architecture implements
- Internal benchmark report: Python vs Go on the customer-create endpoint (Q1 2026)
