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

# A few of the verbs:
npx pmk propose "weekly digest"    # PRD-authoring interview → docs/prds/*.md
npx pmk ask "how does our auth flow work?"   # RAG over your indexed docs
npx pmk case open prod-checkout-503          # long-lived bug investigation file
npx pmk gateway init                          # Slack bridge: paste tokens once
npx pmk gateway start                         # run the bridge in the foreground
```

The CLI delegates code-intelligence work to [**multi-repo-agent (mra)**](https://github.com/hanfour/multi-repo-agent) when present — `pmk ingest mra:--all` loads PKB summaries for every repo in the workspace, and the gateway can auto-trigger `mra ask` when a Slack question requires deep code search. mra is optional; pmk degrades gracefully when it's not installed.

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

## Design principles

1. **Git is the single source of truth.** Everything worth arguing about lives in markdown with front-matter.
2. **Content and framework are separable.** You bring your domain; the kit provides the structure.
3. **Traceability has teeth.** The check runs in CI, not in someone's head.
4. **Human decisions deserve their own file type.** ADRs for technical choices, ADRs for product decisions, both first-class.
5. **Migration is a protocol, not a heroic effort.** The Strangler Fig template gives you four named stages and quantitative exit criteria.
6. **Verbs over commands.** `pmk` exposes PM workflows as named verbs (`propose`, `case`, `gateway`); each one is a structured conversation, not a flag soup.
7. **Code intelligence is delegated.** The CLI doesn't grep; it leans on `mra` for repo-scale code understanding so prompts stay grounded in real module names.

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
