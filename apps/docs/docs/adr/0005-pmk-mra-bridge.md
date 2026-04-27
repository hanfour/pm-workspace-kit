---
doc_id: ADR-2026-0005
title: pmk delegates code intelligence to mra (does not absorb)
owner: "@hanfour"
status: Accepted
date: 2026-04-27
related:
  prd:
    - PRD-2026-0004
  module:
    - packages.cli
    - apps.desktop
  confluence_page_id: null
---

# ADR-0005 — pmk delegates code intelligence to mra (does not absorb)

## Status

**Accepted** — 2026-04-27.

## Context

pmk's chat surface (CLI + desktop ChatPanel) deliberately strips tool-use via the BASE_RULES preamble so the LLM behaves as a pure prose assistant. This was a correct decision for PM-style discussion (no `Skill tool →` leakage, no language drift), but it leaves a gap: the model cannot read code, run shell commands, or follow API call graphs across repos. For real OneAD work the PM/SA needs that depth.

Three options were on the table when v0.5 planning started:

- **A. pmk grows tool-use mode**: lift `allowedTools: []` for specific verbs (`pmk explore`, `pmk explain`). Lets the LLM Read / Grep / Glob / Bash on the user's machine.
- **B. pmk delegates to Claude Code**: `pmk explore` shells out to `claude` directly with the user's prompt + workspace context. Claude Code stays the depth tool; pmk wraps the lifecycle (park, capture findings).
- **C. pmk delegates to mra**: same shape as B, but the subprocess is `mra <repo> --with-deps` instead of `claude`. mra adds cross-repo dependency awareness, PKB memory-stack, persona reviews, and an orchestrator on top of Claude.

mra ([repo](https://github.com/hanfour/multi-repo-agent)) is owned by the same author and already in production use for OneAD. Its capabilities directly cover the gap pmk has:

- Cross-repo dependency detection (5 scanners) — exactly what a PM needs to scope a PRD that touches multiple services.
- 4-layer Project Knowledge Base (~50 tokens to wake an agent vs ~150K) — fixes the "re-explain the codebase every session" cost.
- AI code review with debate / personas — natural fit for `pmk apply` follow-on (v0.7).

## Decision

Adopt **Option C**: pmk delegates code intelligence to mra. pmk does not implement tool-use, does not reimplement multi-repo orchestration, does not maintain its own PKB. The integration is a thin adapter (`packages/cli/src/adapters/mra.ts`) that locates the `mra` binary and shells out to specific subcommands.

Concretely:

- New verb `pmk explore <repo>` invokes `mra <repo> --with-deps` as a subprocess.
- Existing verb `pmk ingest <path>` gains a `mra:<repo>` URI scheme that reads `<repo>/.collab/pkb/{identity,sitemap,architecture,api-surface}.md`.
- pmk and mra remain independent CLIs at the top level. They share the user's `claude` login by virtue of both using Claude Agent SDK on the same machine; auth is not coordinated.

## Consequences

### Positive

- pmk stays focused on its real value (structure: PRD, ADR, traceability, handoff) without growing into a generic agent framework.
- mra's existing strengths (cross-repo, PKB, debate review) become available to PM/SA users without those users having to learn mra directly. The adapter is the on-ramp.
- The BASE_RULES sandbox in pmk's chat stays intact — no `Skill tool →` regression risk.
- Both tools can evolve independently. mra changes its scanner set, pmk's adapter only cares about subcommand interfaces. mra adds a new persona, pmk doesn't change at all.

### Negative

- Two CLIs to install and keep in sync. `pmk doctor` (future) needs to detect mra version mismatch.
- Adapter is a brittle integration point in the medium term: if mra renames a flag or restructures `.collab/`, pmk silently breaks until the adapter is updated. Mitigated by adapter tests that mock the mra subprocess shape.
- Users who don't want mra get a feature-incomplete pmk: `pmk explore` errors out with an install pointer rather than degrading gracefully into "Claude Code on a single repo". Acceptable for v0.5; revisit if the OneAD-only audience widens.
- "Why not absorb mra?" question will recur. The answer (different abstraction layers — pmk = single-PM productivity, mra = multi-repo agent) needs to be in the README and reinforced in code-review.

### Trade-off vs Option A (pmk grows tools)

Rejected because:

- Reintroduces the `Skill tool →` framing problem that ChatPanel and pmk discuss just spent two commits (`da70c78`, `a38bb81`) eliminating.
- Duplicates mra's orchestrator effort. Two implementations diverge.
- pmk's audience includes non-engineering stakeholders (Stakeholder mode) who shouldn't see a code-shell verb.

### Trade-off vs Option B (delegate to Claude Code directly)

Rejected because:

- Claude Code is single-repo. The OneAD use case is multi-repo; option B doesn't actually solve the core problem.
- mra is an existing investment by the same author; not using it would be reinventing.
- Anything we'd build on top of plain Claude Code (PKB, deps detection, persona review) already exists in mra.

## Implementation reference

- PRD: PRD-2026-0004 — pmk × mra integration (v0.5)
- Adapter: `packages/cli/src/adapters/mra.ts`
- Affected commands: `packages/cli/src/commands/explore.ts` (new), `packages/cli/src/commands/ingest.ts` (extended for `mra:` scheme)
- Desktop: status-bar component reads workspace via the same adapter

## Revisit triggers

This decision should be revisited if:

- mra's release cadence diverges from pmk's such that the adapter becomes a bottleneck (>2 sustained version-skew issues per quarter).
- A non-OneAD pmk user explicitly asks for "pmk without mra" — at that point we add a mra-less code-aware fallback (likely Option B).
- A v2 of mra changes its top-level command surface incompatibly. The adapter should be small enough to rewrite, but the cost of two simultaneous v2 transitions might justify rethinking.
