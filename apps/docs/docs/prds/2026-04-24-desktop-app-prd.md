---
doc_id: PRD-2026-0002
title: pmk Desktop App
owner: "@hanfour"
status: Draft
date: 2026-04-24
related:
  requirement: []
  plan:
    - docs/plans/2026-04-24-desktop-app-sprint-plan.md
  spec: []
  architecture: []
  adr:
    - ADR-0004
  module:
    - apps.desktop
    - packages.cli
    - packages.rag
  confluence_page_id: null
---

# pmk Desktop App

## 1. Executive Summary

A desktop GUI + CLI app that packages pm-workspace-kit's workflow — traceability, ADRs, Strangler Fig migration, Claude Code skills — into a single installable binary. Inspired by [Spectra](https://kaochenlong.com/spectra-app-2) (GUI for OpenSpec). Lets PMs, SAs, and engineers run the full kit without installing Node, Docusaurus, or Claude Code separately.

Open source under MIT, same repo as the kit (monorepo at `apps/desktop/` + `packages/cli/`).

## 2. Problem Definition

### Current pain

| Pain | Who feels it |
|---|---|
| Kit setup requires Node + Claude Code + multiple npm commands | Non-engineer PMs |
| No GUI for browsing specs / rendering Mermaid / file preview | All users |
| No RAG — searching 50+ PRDs / ADRs is `grep` work | Everyone past 3 months of kit use |
| Juggling 3+ WIP PRDs pollutes Git with half-baked commits | Solo PMs, small teams |
| Non-engineering stakeholders can't consume the workflow at all | Product, Design, Ops |
| No consolidated "verb" command — 15 scattered slash commands | New adopters |

### Desired outcome

A single binary (`pmk` CLI + desktop app) that wraps every common PM workflow step, runs offline (except LLM calls), and is as installable as Figma or Postman.

## 3. Goals & Success Metrics

| Goal | Metric | Target (v1.0) |
|---|---|---|
| Zero-setup install | Time from download to first command | ≤ 3 min |
| CLI command consolidation | Core verbs replacing Claude Code slashes | 6 (propose/ingest/apply/discuss/ask/debug) |
| RAG query precision | Top-3 result relevance on 100-PRD corpus | ≥ 85% |
| Desktop app adoption | Active users after 3 months | ≥ 50 (including non-kit users) |
| Cross-platform | Platforms supported at v1.0 | macOS, Windows, Linux |
| Bundle size | Installer size | ≤ 120 MB (Electron-typical) |
| Startup time | Cold launch to usable UI | ≤ 2 s |

## 4. Non-Goals

- **Not a collaborative editor** — single-user local tool; multi-user sync is out of scope
- **Not a Confluence replacement** — still integrates via existing `confluence-sync`
- **Not a prompt playground** — opinionated skill-based flows, not free-form prompt tinkering
- **Not a Jira/Linear replacement** — tickets stay where they are
- **Not a mobile app** — desktop only

## 5. Target Users

| Persona | Primary use |
|---|---|
| **Solo PM / SA** | Write PRDs, manage 2–5 concurrent specs, query old decisions |
| **Engineering lead** | Review PRDs, write ADRs, plan module migrations |
| **Non-engineer PM** | Follow kit workflow without terminal-only friction |
| **Small team (2–5 people)** | Share kit conventions across a repo |

## 6. Functional Requirements

### Core (must ship in v0.1)

- **F1 — Install & first-run**: Single binary (`.dmg` / `.msi` / `.AppImage`). First run: config dialog for Anthropic API key (stored in OS keychain). No Node required.
- **F2 — CLI (`pmk`)**: 6 verb commands:
  - `pmk propose` — create new PRD / ADR / spec (replaces `/requirement-intake`, `/create-prd`, `/generate-prd`)
  - `pmk ingest <path>` — load existing doc into context for continuation
  - `pmk apply <plan>` — execute decomposed tasks from a plan
  - `pmk discuss <topic>` — structured brainstorm with the model
  - `pmk ask "question"` — RAG query over your corpus
  - `pmk debug <module>` — systematic troubleshooting flow
- **F3 — Desktop app shell**: Electron + React. Layout: file tree (left), editor (center), preview/terminal (right).
- **F4 — Spec editor**: Monaco editor with front-matter validation, Markdown syntax highlight, command palette.
- **F5 — Markdown + Mermaid preview**: Live preview pane, renders diagrams inline.
- **F6 — Traceability matrix panel**: Visual dependency graph (force-directed), click node to open file, stale indicator.
- **F7 — Multi-language UI**: EN + zh-TW, same format as Docusaurus site.
- **F8 — API key & billing management**: Settings pane. Shows cumulative token usage per month.

### Advanced (all in v1.0 per user decision)

- **F9 — RAG `ask`**: Index all tracked docs (via embedding), sub-second top-k retrieval, answers with citations back to source file + line.
- **F10 — Park / WIP management**: Pause a spec mid-edit, restore later. State persists to `.pmk/park/<name>/` (gitignored). UI: "Park drawer" with list + restore.
- **F11 — Git worktree integration**: "New parallel worktree" button. Creates `<repo>/../worktree-<branch>/`, opens in new window. `pmk worktree list/switch/prune`.
- **F12 — File sharing**: "Share preview" generates a 24h signed URL (via Vercel Blob or CF R2), returns a link. Uploaded content: rendered HTML + assets.
- **F13 — Parallel task execution**: Run multiple Claude API calls concurrently for decomposed tasks; UI shows per-task progress, tokens, cost.
- **F14 — TDD-specific flow**: `pmk tdd` prompts write test → red → code → green → refactor. UI stages.
- **F15 — Simplified UI mode**: "Stakeholder view" hides editor, shows only spec browser + approval buttons. For non-engineer reviewers.

### Out of scope for v1.0

- Cloud sync across devices
- Collaborative real-time editing
- Plugin system / custom commands by user
- Non-Anthropic LLMs (Claude only; other providers post-v1.0)
- Self-hosted RAG (uses Anthropic embeddings or local sentence-transformers)
- Mobile companion

## 7. Technical Architecture (summary; full detail in ADR-0004)

- **Shell**: Electron 33+ with Vite for renderer
- **Frontend**: React 19 + TypeScript; Monaco editor; Radix UI primitives; Tailwind or CSS modules
- **Main process**: Node 20; file system access via `fs`, Git via `simple-git`, shell via `execa`
- **State**: Zustand or Jotai; persisted state via `electron-store` + keychain for secrets
- **LLM**: `@anthropic-ai/sdk` (streaming); token accounting in `packages/shared`
- **RAG**: `better-sqlite3` + `hnswlib-node` for vector index; `@anthropic-ai/sdk` embeddings or Voyage AI
- **CLI**: Commander; TUI via `@clack/prompts` or `ink` for interactive prompts; shares `packages/core` + `packages/rag` with desktop
- **Bundling**: `electron-builder`; notarize macOS, sign Windows; Linux AppImage + Snap
- **Distribution**: GitHub Releases (auto-update via `electron-updater`)

Packages:

```
packages/
├── core/    — shared utilities (existing traceability + confluence-sync scripts migrate here)
├── cli/     — pmk CLI binary
├── rag/     — embedding, index, retrieval
└── shared/  — types, config schema, prompt templates
apps/
├── docs/    — Docusaurus site (this PRD lives here)
└── desktop/ — Electron app
```

## 8. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Electron bundle > 150 MB blows install UX | M | Med | Strip unused Chromium locales; code-split renderer |
| API key leakage via log | L | High | Redact at sink; never write to disk outside keychain |
| RAG index corruption on rebuild | M | Med | Versioned index dir; fallback to full rebuild |
| Cost: unbounded LLM calls | H | High | Per-command budget + monthly cap in settings |
| Code signing cert costs ($99/yr Apple + $300+/yr Windows) | H | Med | Initial release unsigned with installation guide; signing in v1.1 |
| Spectra already covers OpenSpec users — no market differentiation | M | Med | Target pm-workspace-kit users + SDD-agnostic workflow; separate niche |
| Scope creep from "全部 Advanced" | **H** | **High** | Strict M1→M7 milestone gates (see sprint plan); defer F12/F13 to v1.1 if M5 slips |

## 9. Open Questions

- [ ] Bundled LLM model vs BYO key: all users must BYOK, or embed Anthropic proxy for demo?
- [ ] Telemetry: anonymous usage stats? opt-in?
- [ ] Update channel: auto-update default-on, or prompt user?
- [ ] Auth for file-sharing feature: which provider (Vercel Blob / CF R2 / S3)?
- [ ] Single-binary via `pkg` / `bun compile` for CLI: v1.0 or later?

## 10. Timeline

Detailed milestone breakdown in [Sprint plan](../plans/2026-04-24-desktop-app-sprint-plan). High-level:

- **M0 — Monorepo refactor** (done 2026-04-24)
- **M1 — CLI scaffold + 6 verbs** (2 weeks)
- **M2 — Electron shell + editor** (2 weeks)
- **M3 — Mermaid preview + traceability graph** (2 weeks)
- **M4 — RAG** (2 weeks)
- **M5 — Park + worktree + parallel** (3 weeks)
- **M6 — File sharing + TDD flow** (2 weeks)
- **M7 — Stakeholder UI + polish + package** (2 weeks)

**Total estimate**: ~15 weeks part-time (~3–4 months).

## 11. Success Criteria for v1.0

- All 15 Functional Requirements shipped or explicitly deferred with reason
- Cross-platform install works on macOS 13+, Windows 11, Ubuntu 22.04+
- First-run to first command ≤ 3 min
- README + Getting Started page in Docusaurus for the app
- Open source release on GitHub with ≥ 1 external contributor by v1.1

## Appendix — Related Decisions

- [ADR-0004](../adr/desktop-framework) — Electron vs Tauri decision
- Sprint plan — [2026-04-24-desktop-app-sprint-plan.md](../plans/2026-04-24-desktop-app-sprint-plan)
