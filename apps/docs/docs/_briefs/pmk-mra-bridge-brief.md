# Brief — pmk × mra integration (v0.5)

## Context

`pmk` (this repo) is a personal AI-native PM productivity tool: 10 CLI verbs +
Electron desktop, all wrapped around the user's Claude Code OAuth. It's
strong at **structuring PM artefacts** (PRD authoring, ADR, traceability,
stakeholder views, RAG over `docs/`) but deliberately strips tool-use from
its LLM chat — so it can't read code, can't follow API call graphs, can't
review diffs. For real OneAD ERP work the PM/SA needs that depth.

`mra` (multi-repo-agent, at `~/multi-repo-agent`) is the user's existing
open-source tool that already covers the depth side: cross-repo dependency
detection (5 scanners), AI code review with debate / personas, a 4-layer
PKB memory stack that wakes an agent in ~50 tokens vs 150K, and an
orchestrator that dispatches Claude sub-agents per repo in dependency order.

The two are complementary, not overlapping. v0.5 should bridge them so
**the PM gets one workflow that uses pmk's structure on top of mra's code
intelligence**.

## Problem

Today, a PM/SA who needs to write a PRD that touches existing code has to:

1. Open Claude Code in one repo, ask "what does this module do" — Claude only sees that one dir
2. Manually inspect related repos to figure out who else consumes the API
3. Read code into their head, switch to a markdown file, write the PRD
4. The PRD references functions / endpoints by guess; no traceability back to actual code
5. Review of the resulting code change is whatever the reviewer remembers

The user already solved (1)+(2) inside `mra`. pmk solved the markdown / structure side. They just don't talk yet.

## Goals

- A PM can run **one pmk command** and get a PRD draft seeded with the
  actual current behaviour of the system across all relevant repos.
- A PM can hand off a finished PRD with **automatic links to affected
  files / repos / API surfaces**, generated from mra PKB.
- `pmk apply` can route the resulting code-change tasks through
  `mra review` so each commit gets the debate / persona check before
  merge.
- Desktop UI surfaces the bridge — at minimum a status indicator
  showing the current mra workspace, plus a "Open in mra" affordance.

## Non-goals

- pmk does **not** absorb mra's CLI surface — they stay independent.
- pmk does **not** reimplement multi-repo orchestration, code review,
  or PKB. Those stay mra's job.
- This v0.5 milestone is **not** about adding tool-use to pmk's chat
  pane — that would defeat the purpose of the BASE_RULES sandbox.
  pmk delegates to mra as a subprocess instead.
- Auth is **not** changed. pmk continues to use its own
  resolveProvider; mra continues to manage its own Claude / API
  setup. They share the user's `claude` login by virtue of both
  using Claude Agent SDK.

## In scope (v0.5 surface area)

### CLI

- `pmk explore <repo>` — spawn a `mra <repo> --with-deps` subprocess,
  pipe the conversation through pmk's REPL, auto-park on exit to
  `~/.pmk/parks/explore-<repo>.json`. Exit code mirrors mra's.

- `pmk ingest mra:<repo>` — read `~/<workspace>/<repo>/.collab/pkb/{identity,sitemap,architecture,api-surface}.md`
  and load all four into the conversation context. From there the
  user can pivot to `pmk propose` with a fully-loaded model.

- Adapter layer: a new `packages/cli/src/adapters/mra.ts` that
  encapsulates "where is mra installed", "where is its workspace
  config", "shell out to a specific subcommand". One place to fix
  if mra renames a flag.

### Desktop

- Bottom status bar shows mra workspace name when `~/<workspace>/.mra-config`
  is detected.
- "Open in mra" button next to the file tree path label — spawns
  the user's terminal with `mra <inferred-repo> --with-deps` pre-typed.

### Docs

- New ADR (`apps/docs/docs/adr/0005-pmk-mra-bridge.md`) capturing
  the "delegate, don't reimplement" decision and the trade-off
  vs absorbing mra's features.
- README update: a "pmk + mra" section explaining the workflow.

## Out of scope (deferred to v0.6 / v0.7)

- `pmk handoff` consuming PKB to produce a brief (v0.6 — needs the
  ingest path proven first).
- `pmk apply --review-with mra` (v0.7 — needs apply to actually
  write code, which is out of scope for v0.5 too).
- Cross-corpus RAG (v0.6 — pmk index that walks both `docs/` and
  per-repo `.collab/pkb/`).
- Desktop chat pane "Explore" mode that streams mra orchestrator
  output into the right pane (v0.7).

## Constraints

- **No new runtime deps** in pmk. mra is invoked via `child_process`
  with its existing `mra` binary. If `mra` isn't on PATH, pmk degrades
  gracefully — `pmk explore` prints "install mra at <link>" and exits.
- The integration must work whether the user installed mra to
  `~/multi-repo-agent` (their layout) or somewhere else. Resolve via
  `which mra` first, then a small set of well-known fallback paths.
- pmk's existing 61 tests must stay green. New tests for the adapter
  layer should run **without** actually invoking mra (mock the
  subprocess shape).

## Stakeholders / decisions to make

- @hanfour — owner of both pmk and mra; final call on adapter API shape.
- SA collaborators on OneAD — passive consumers; their feedback comes
  from whether the resulting handoff briefs are usable.

## Open questions (for the model to answer in the PRD)

1. Should `pmk explore` reuse pmk's REPL infrastructure or stream mra's
   stdout straight through? (Trade-off: REPL gets us /park, but mra's
   own REPL has features we'd lose by intercepting.)
2. PKB files live under `<repo>/.collab/pkb/`. If a workspace has 8
   repos, `pmk ingest mra:` needs a multi-repo selector. CLI flag
   `--repo` or a follow-up prompt?
3. mra's auth model is "user already has `claude` login". pmk's
   provider resolver also assumes this. Should the bridge add a
   pre-flight check (`mra doctor`-style) before any explore call,
   or trust the user?
4. Failure mode when mra is mid-PKB-update and a PRD references
   stale module summaries — flag it in the PRD with a `<!-- TODO -->`
   marker, or block until PKB rebuild?

## Success criteria

- [ ] `pmk explore <repo>` works end-to-end on one of the OneAD repos,
  produces a parked session, no manual mra invocation needed.
- [ ] `pmk ingest mra:<repo>` followed by `pmk propose --from <spec>`
  produces a PRD whose Functional Requirements section references
  real endpoints / modules from PKB, not invented ones.
- [ ] mra's existing `mra review` and `mra analyze` keep working
  unchanged — pmk does not break the mra workflow when not invoked.
- [ ] One real OneAD PRD authored end-to-end through the bridge in
  ≤ 30 minutes (current baseline: 2–3 hours of context-switching).
- [ ] Desktop app shows the mra workspace name in the status bar.
- [ ] All 61 pmk tests still green; new adapter tests cover happy
  path + mra-not-installed + workspace-not-detected.
