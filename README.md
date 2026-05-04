# PM Workspace Kit

> An opinionated PM / SA workspace kit: traceability front-matter, ADRs, Strangler Fig migration, AI-friendly documentation templates — plus a CLI (`pmk`), a Slack gateway, and a desktop app that build on top of those primitives.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE) [![Docs](https://img.shields.io/badge/docs-live-blue)](https://hanfour.github.io/pm-workspace-kit/) [![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](#prerequisites)

## Why this exists

Most PM tooling either lives in a wiki (search is fine, structure is fiction) or in a ticketing system (tasks are fine, rationale is absent). Neither survives a platform migration.

This kit is what we used to plan a monolith → TypeScript migration of an 11-module ERP system without writing a single line of production code, and still handing engineering a runnable plan. The core is **domain-independent**: front-matter schema, validation scripts, ADR format, Strangler Fig protocol, handoff templates, north-star skeleton. On top of that core, the kit ships a CLI (`pmk`) that turns each PM verb into a repeatable conversation, a Slack gateway so stakeholders can drive `pmk` from the messengers they already use, and a desktop GUI for the same surface.

## What's in here

The repo is a monorepo with three product surfaces sharing one set of templates and one traceability core.

| Surface | What it does | Location |
|---|---|---|
| **Docs site** | Docusaurus, EN + zh-TW; templates, ADRs, concepts, guides | [`apps/docs/`](./apps/docs/) → [hanfour.github.io/pm-workspace-kit](https://hanfour.github.io/pm-workspace-kit/) |
| **`pmk` CLI** | propose / ingest / apply / discuss / ask / debug / index / resume / worktree / tdd / explore / case / **gateway** | [`packages/cli/`](./packages/cli/) |
| **Desktop app** | Electron GUI over the same CLI surface (chat panel + worktree manager) | [`apps/desktop/`](./apps/desktop/) |
| **Traceability + Confluence sync core** | Front-matter validation, Mermaid graph, orphan detection, Confluence comment + label sync | [`packages/core/`](./packages/core/) |
| **Methodology ADRs + handoff templates** | Strangler Fig, Dev Harness, Product Decision Log; PR / review / runbook / dashboard / readiness | [`apps/docs/docs/adr/`](./apps/docs/docs/adr/), [`apps/docs/docs/handoff/`](./apps/docs/docs/handoff/) |
| **Worked example** | Fictional ad-tech company (AcmeAds) using the kit end-to-end | [`examples/acme-ads/`](./examples/acme-ads/) |

## Quick start

### Prerequisites

- Node.js ≥ 20
- Git

### Clone + install

```bash
git clone https://github.com/hanfour/pm-workspace-kit.git my-workspace
cd my-workspace
npm install
```

### A. Docs + traceability (the original kit)

```bash
# Validate front-matter on your docs
npm run traceability:check

# Regenerate the dependency graph (Mermaid + reverse-lookup + orphans)
npm run traceability:matrix

# Serve the docs site locally
#   npm start                       → single-locale dev mode (hot reload)
#   npm start -- --locale zh-TW     → dev mode on the Chinese locale
#   npm run build && npm run serve  → production build with both locales
#                                     and working language switcher
npm start
```

### B. CLI (`pmk`)

```bash
npm run cli:build                  # builds packages/cli → dist
npx pmk --help                     # or: npm run pmk -- --help

# Doc-authoring + investigation verbs
npx pmk propose "weekly digest"              # PRD interview → docs/prds/*.md
npx pmk ask "how does our auth flow work?"   # RAG over your indexed docs
npx pmk case open prod-checkout-503          # long-lived bug investigation file

# Slack gateway (v0.7+) — host-run bridge so PMs/stakeholders DM pmk in Slack
npx pmk gateway init                          # one-time: paste Slack tokens + mra workspace path
npx pmk gateway start                         # run the bridge (foreground)
npx pmk gateway status                        # configured? running? mra workspace ok?
npx pmk gateway admin add <userId>            # (v0.9) bootstrap first Slack admin — required for /pmk admin
npx pmk gateway audience set <userId> pm      # (v0.8) tech / pm / biz / exec tone per user
npx pmk gateway escalation add <repo> <userId>  # IT/domain contact pool for `escalate`
npx pmk gateway atoms list --pending          # absorbed knowledge atoms awaiting promotion
npx pmk gateway atoms approve <id-prefix>     # promote a pending atom to retrieval-visible
# After bootstrap: in Slack DM with the bot, run `/pmk admin help` for the in-Slack surface (v0.9).
```

The CLI delegates code-intelligence work to [**multi-repo-agent (mra)**](https://github.com/hanfour/multi-repo-agent) when present. The gateway specifically uses three integrated mechanisms:

- **PKB seed** — first DM/channel turn loads the `mra:--all` summary set so the model grounds answers in real module names from turn one.
- **Auto-mra-ask** — when PKB isn't enough, the model emits a fenced `mra-ask` block; pmk runs `mra ask <repo>` and feeds the result back for synthesis.
- **Escalate → absorb → retrieval** — when neither PKB nor mra-ask suffices, the model emits an `escalate` block; pmk @-mentions a registered IT contact in the thread, absorbs their reply as a `KnowledgeAtom`, and retrieves it (after a 24h pending TTL or explicit `pmk gateway atoms approve`) for future similar questions.

mra is optional; pmk degrades gracefully when it's not installed (mra-ask becomes a no-op, the model falls back to PKB-only).

### C. Desktop app

```bash
npm run desktop:dev                # Electron + Vite dev mode
npm run desktop:build              # packaged app bundles
```

## Adopting the kit for your project

You don't have to take the whole monorepo. Pick the layer that matches your need:

1. **Just the templates + traceability** — copy [`apps/docs/docs/handoff/`](./apps/docs/docs/handoff/), [`apps/docs/docs/templates/`](./apps/docs/docs/templates/), [`apps/docs/docs/adr/`](./apps/docs/docs/adr/), and [`packages/core/`](./packages/core/) into your repo, then drop [`.github/workflows/traceability-check.yml`](./.github/workflows/traceability-check.yml) into your `.github/workflows/`.
2. **+ the CLI** — install `@pmk/cli` from the workspace, run `pmk propose` / `pmk ask` / `pmk case` against your existing docs.
3. **+ the gateway** — `pmk gateway init` to wire a Slack app for your team; stakeholders DM the bot, channel `@mention`s create case files.

Read [Getting Started](https://hanfour.github.io/pm-workspace-kit/docs/getting-started) to set up front-matter on your first PRD; the [Confluence sync guide](https://hanfour.github.io/pm-workspace-kit/docs/guides/confluence-sync) covers the Confluence loop.

## Latest release: v0.10.0 (2026-05-04)

The v0.7.x series matured the Slack gateway through real dogfood; v0.8.x built retrieval quality and an in-Slack approval loop on top; v0.9.0 brought the operator surface into Slack; v0.9.1 closed the last UX gap by registering `/pmk` as a real Slack slash-command; v0.10.0 turned both kinds of observability on — `pmk gateway audit` for historical knowledge-loop telemetry, and live mra-ask progress streaming so the 30–90s round shows movement in Slack.

| Release | Highlight |
|---|---|
| [`v0.7.0`](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.7.0) | Gateway baseline (Socket Mode, audience prompts, escalate/absorb/retrieval scaffolding) |
| [`v0.7.1`](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.7.1) | Prompt override fix — without it, mra-ask / escalate directives silently never fired |
| [`v0.7.2`](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.7.2) | Explicit `mraWorkspace` config, mra stderr surfaced, `pmk gateway escalation add default` positional |
| [`v0.7.3`](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.7.3) | Startup mra validation, `runMraAsk` retry-once on transient flake, helpers extracted |
| [`v0.7.4`](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.7.4) | Atom approval **TTL hybrid** — fresh atoms enter `pending` for 24h, auto-promote, or `pmk gateway atoms approve <id>` early |
| [`v0.7.5`](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.7.5) | mra timeout-kill no longer mis-classified as `Command failed` — surfaces the real reason in apologies |
| [`v0.8.0`](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.8.0) | **PM audience tier** — `tech` / `pm` / `biz` / `exec` with translation cheat-sheet, file-line refs OK but no formulas in question-back-to-user |
| [`v0.8.1`](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.8.1) | Session context-window auto-pruning — drops oldest turns past `MAX_SESSION_TOKENS`, preserves PKB seed + last 10 pairs |
| [`v0.8.2`](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.8.2) | Escalate **self-tag detection** — surfaces a config-fix hint instead of silently @-mentioning the asker |
| [`v0.8.3`](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.8.3) | `pmk gateway atoms search / edit` + Commander option pass-through (`--pending`, `--scope`, `--limit` no longer eaten) |
| [`v0.8.4`](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.8.4) | **BM25 / TF-IDF retrieval** for knowledge atoms — corpus-size threshold switches between keyword and BM25 |
| [`v0.8.5`](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.8.5) | **Slack reaction approval** — ✅ / ❌ on the bot's pending notice approves or rejects in-flow (only the original IT contributor) |
| [`v0.9.0`](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.9.0) | **`/pmk admin <subcommand>`** — DM-only admin surface for audience / escalation / atoms / admins / audit, with append-only JSONL audit log spanning Slack + CLI origins |
| [`v0.9.1`](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.9.1) | **`/pmk` real Slack slash-command** — Socket Mode `slash_commands` envelope handler so Slack autocompletes `/pmk` and the leading-space workaround is no longer needed |
| [`v0.10.0`](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.10.0) | **Gateway observability + Slack UX** — `pmk gateway audit [--days N]` rollup of recent knowledge-loop telemetry (per-user turn split, mra-ask duration percentiles, atom corpus stats); spawn-based `runMraAsk` streams `[ask] ...` progress lines into the Slack placeholder via a 3s last-line-wins throttle so the 30–90s round shows movement instead of a static spinner |

The full knowledge loop — *PM asks in Slack → bot tries PKB → escalates to mra-ask → escalates to a human IT contact → absorbs the answer → next person who asks gets the cached answer* — works end-to-end, with retrieval quality improved by BM25 (v0.8.4), in-flow ✅ approval (v0.8.5), Slack-side admin commands (v0.9.0), a properly-registered `/pmk` slash-command (v0.9.1), and now historical + live observability on top of it (v0.10.0). Tests: 75 → **247** across the v0.7–v0.10 series. Walk through it phase-by-phase in the [Gateway lifecycle](https://hanfour.github.io/pm-workspace-kit/docs/gateway/lifecycle) deep-dive (now with a Phase 11 covering admin commands), or skim the release-by-release [changelog](https://hanfour.github.io/pm-workspace-kit/docs/changelog).

## Design principles

1. **Git is the single source of truth.** Everything worth arguing about lives in markdown with front-matter.
2. **Content and framework are separable.** You bring your domain; the kit provides the structure.
3. **Traceability has teeth.** The check runs in CI, not in someone's head.
4. **Human decisions deserve their own file type.** ADRs for technical choices, ADRs for product decisions, both first-class.
5. **Migration is a protocol, not a heroic effort.** The Strangler Fig template gives you four named stages and quantitative exit criteria.
6. **Verbs over commands.** `pmk` exposes PM workflows as named verbs (`propose`, `case`, `gateway`); each one is a structured conversation, not a flag soup.
7. **Code intelligence is delegated.** The CLI doesn't grep; it leans on `mra` for repo-scale code understanding so prompts stay grounded in real module names.
8. **Knowledge needs a half-life.** Absorbed atoms enter a 24h pending state; the host can approve early or let the timer run. Mistakes get a window to be caught before they propagate via retrieval.

## GitHub Pages

The docs site auto-deploys from `main` whenever `apps/docs/**` or root lockfiles change — see [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml). Live at:

- **Production**: https://hanfour.github.io/pm-workspace-kit/
- **繁體中文**: https://hanfour.github.io/pm-workspace-kit/zh-TW/

To preview a build locally before pushing: `npm run build && npm run serve`.

## Languages

The docs site is available in **English** (primary) and **繁體中文**. The framework itself is language-agnostic — use whatever your team works in for your actual content.

## License

[MIT](./LICENSE). Use it, fork it, strip it, relicense your internal content however you like. Attribution appreciated but not required.

## Origin

Extracted from a real internal PM workspace used for an ERP migration project. The content was domain-specific; the kit here is the 70% that wasn't. The CLI and gateway were added later, dogfooded against the same ERP migration that birthed the templates.
