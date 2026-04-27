---
doc_id: PRD-2026-0004
title: pmk × mra integration (v0.5)
owner: "@hanfour"
status: Draft
date: 2026-04-27
related:
  requirement: []
  plan: []
  spec: []
  architecture: []
  adr:
    - ADR-0005
  module:
    - packages.cli
    - apps.desktop
  confluence_page_id: null
---

# pmk × mra integration (v0.5)

## 1. Executive Summary

`pmk` (PM/SA productivity tool, this repo) is strong at structuring artefacts — PRD, ADR, traceability, RAG over docs — but deliberately strips tool-use from its LLM chat, so it cannot read code or follow API graphs. `mra` ([multi-repo-agent](https://github.com/hanfour/multi-repo-agent), at `~/multi-repo-agent`) covers the depth side: cross-repo dependency detection, AI code review with debate / personas, a 4-layer PKB memory stack, and an orchestrator that dispatches Claude sub-agents per repo. The two tools are complementary; v0.5 bridges them so a PM gets one workflow that uses pmk's structure on top of mra's code intelligence — without duplicating either.

## 2. Problem Definition

- **Current pain**
  - PMs writing a PRD that touches existing code switch contexts ~10× per draft: terminal → code → chat → markdown → repeat.
  - Claude Code only sees one repo at a time; a PRD that spans `erp/order` + `erp/billing` + `frontend-orders` requires manually loading each.
  - PRDs reference functions / endpoints by guess; nothing links the markdown back to actual file paths or commit SHAs.
  - Reviews of the resulting code change rely on whatever the reviewer remembers from the PRD discussion three weeks earlier.

- **Desired outcome**
  - Single command (`pmk explore <repo>`) gives a PM full multi-repo context via mra, with the conversation auto-parked.
  - `pmk propose` can ingest mra PKB and produce a PRD whose Functional Requirements section cites real endpoints, not invented ones.
  - The handoff from PRD to engineering carries the code-intelligence with it (deferred to v0.6 — see §4).
  - End-to-end PRD authoring time on a real OneAD requirement drops from 2–3 hours to ≤ 30 minutes.

## 3. Goals & Success Metrics

| Goal | Metric | Target |
|---|---|---|
| Reduce PM context-switch cost | End-to-end PRD authoring time on a real OneAD requirement | ≤ 30 min (baseline 2–3 hrs) |
| PRD references match real code | Manual audit of FRs against mra PKB after `pmk propose --from <brief>` | ≥ 80% of named modules / endpoints exist in PKB |
| Bridge does not break mra | `mra review` and `mra analyze` exit codes / output unchanged when invoked outside pmk | 100% pass on existing mra test suite |
| pmk regression | Existing pmk unit tests | 61/61 still green |
| Adapter robustness | New adapter tests cover happy / mra-missing / workspace-undetected | 100% branch coverage on `adapters/mra.ts` |

## 4. Non-Goals

- pmk **does not** absorb mra's CLI surface — `mra review`, `mra analyze`, `mra orchestrator` stay invoked as `mra ...`, not aliased into pmk verbs.
- pmk **does not** reimplement multi-repo orchestration, code review, PKB, or scanners.
- v0.5 **does not** add tool-use to pmk's chat pane. The BASE_RULES sandbox stays — depth comes from delegating to mra, not from re-arming the chat with file/shell tools.
- v0.5 **does not** ship `pmk handoff` (PRD → SA brief). That depends on the ingest path being proven first; targeted at v0.6.
- v0.5 **does not** ship `pmk apply --review-with mra`. `apply` doesn't write code today; routing its output through mra review is v0.7 once apply is upgraded.
- Auth flow **is not** changed. Both tools use Claude Agent SDK, so they share the user's `claude` login by virtue of running on the same machine.

## 5. User Stories

**US-01 — explore an unfamiliar repo before writing a PRD**
> As a PM with a new ERP requirement, I run `pmk explore erp/order` and immediately have a Claude session loaded with `erp/order` plus every repo that consumes its API, so I can ask "what does the tax-calculation flow currently do" and get an answer grounded in actual code, not a guess.

**US-02 — author a PRD that's anchored to real code**
> As a PM, I run `pmk ingest mra:erp/order` to load the four PKB summary docs, then `pmk propose --from <my brief>`. The resulting PRD's Functional Requirements section cites concrete endpoints (`POST /orders/calculate-tax`) and modules (`apps.erp.order.tax`), not invented placeholders. <!-- TODO(owner): link the PKB document IDs once mra exposes a stable identifier -->

**US-03 — keep both tools usable independently**
> As a developer, I can keep using `mra review --pr 123` for any PR without going through pmk. pmk's existence does not insert itself into the mra workflow.

**US-04 — see the bridge in the desktop UI**
> As a PM in the desktop app, the status bar shows me which mra workspace I'm currently in, and I can right-click a file in the tree to open it in mra with full dependency context.

## 6. Functional Requirements

- **Must have**
  - `pmk explore <repo>` spawns `mra <repo> --with-deps` as a subprocess; conversation streamed through pmk's REPL infrastructure; auto-parks to `~/.pmk/parks/explore-<repo>.json` on exit. <!-- TODO(owner): decide pass-through vs interception — see §10 Q1 -->
  - `pmk ingest mra:<repo>` reads `~/<workspace>/<repo>/.collab/pkb/{identity,sitemap,architecture,api-surface}.md` and seeds the conversation context. Falls through to existing `pmk ingest <path>` for plain files.
  - New `packages/cli/src/adapters/mra.ts` encapsulates: locating `mra` binary, locating workspace root, building subprocess command, parsing common output. Single point of change if mra renames a flag.
  - When `mra` is not on PATH, `pmk explore` and `pmk ingest mra:` print an actionable message ("install mra at <link>") and exit non-zero — they do not silently fall back.
  - When `mra` is found but the requested workspace / repo doesn't exist, error is specific ("repo `erp/order` not found in workspace `~/onead`").

- **Should have**
  - Desktop status bar component shows current mra workspace name (read from `<workspace>/.mra-config` or equivalent). Hidden when no workspace detected.
  - "Open in mra" button on the file tree path label — copies / runs `mra <inferred-repo> --with-deps` in the user's default terminal.
  - Adapter exposes a `mraDoctor()` health check function used by both CLI and desktop to surface mismatches before invocation.

- **Could have**
  - `pmk explore --with-pkb` flag that pre-loads the four PKB docs into the explore session opener (saves the ingest step).
  - Tab-completion / shell completion for `pmk explore <repo>` when an mra workspace is detected.

- **Won't (this release)**
  - `pmk handoff` consuming PKB — v0.6.
  - Cross-corpus RAG (`pmk index` walks `docs/` + `<repo>/.collab/pkb/`) — v0.6.
  - Desktop chat pane "Explore" mode that streams mra orchestrator output — v0.7.
  - Routing `pmk apply` output through `mra review` — v0.7.

## 7. Risks

- **mra CLI surface changes between releases** — adapter is the single point of change, but a major mra version bump could still break pmk explore. *Mitigation*: pin the minimum supported mra version in adapter; `pmk explore` runs `mra --version` and warns if below threshold.
- **PKB staleness during PRD authoring** — if mra's PKB rebuild lags, ingested context describes yesterday's code. *Mitigation*: adapter checks PKB mtime vs last `git log -1` on the repo, flags inline `<!-- TODO: PKB stale, regen with `mra analyze` -->` markers in the PRD draft. <!-- TODO(owner): confirm mra exposes PKB build timestamp -->
- **Subprocess auth divergence** — pmk's resolveProvider and mra's auth could in principle disagree (e.g. PMK_PROVIDER=anthropic-api while mra uses claude OAuth). *Mitigation*: explore command detects mismatch and warns; doesn't try to reconcile.
- **Desktop "Open in mra" UX is flaky on Windows** — terminal launching is platform-specific. *Mitigation*: macOS/Linux first; Windows ships in v0.6 with explicit Windows Terminal / WSL paths.
- **User has multiple mra workspaces** — current detection assumes one. *Mitigation*: v0.5 picks the nearest ancestor `.mra-config`; multi-workspace switching is v0.6 if real users hit the limit.

## 8. Open Questions

1. Should `pmk explore` reuse pmk's REPL infrastructure (gets us `/park`, `/done`, paste auto-detection) or stream `mra`'s stdout straight through (preserves whatever REPL features mra has)? *Lean*: reuse pmk REPL; benefits compound across other future bridges. <!-- TODO(owner): confirm -->
2. PKB files live under `<repo>/.collab/pkb/`. If a workspace has 8 repos, `pmk ingest mra:` needs a multi-repo selector. CLI flag `--repo` (explicit) or interactive picker? *Lean*: `--repo` for scriptability; interactive picker in desktop only.
3. Should the bridge add a pre-flight check (`mra doctor`-style) before any explore call, or trust the user? *Lean*: yes, `mraDoctor()` runs once per session, caches result for 5 minutes.
4. mra emits PKB files into `.collab/pkb/<module>.md`. If a repo has 50 modules, ingesting all four summaries plus 50 module deep-dives blows the context window. *Open*: should `ingest mra:<repo>` default to L0+L1+L2 of the memory stack, with `--deep` for L3?
5. Naming — is `pmk explore` the right verb, or should it be `pmk dig` / `pmk read` / `pmk inspect`? *Lean*: explore — matches mra's mental model and is unambiguous next to existing `propose`/`ingest`/`ask`.
