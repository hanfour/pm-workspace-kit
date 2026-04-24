# PM Workspace Kit

> An opinionated PM / SA workspace kit: traceability front-matter, ADRs, Strangler Fig migration, AI-friendly documentation templates — with working scripts and a multilingual docs site.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE) [![Docs](https://img.shields.io/badge/docs-live-blue)](https://hanfourhuang.github.io/pm-workspace-kit/)

## Why this exists

Most PM tooling either lives in a wiki (search is fine, structure is fiction) or in a ticketing system (tasks are fine, rationale is absent). Neither survives a platform migration.

This kit is what we used to plan a monolith → TypeScript migration of an 11-module ERP system without writing a single line of production code, and still handing engineering a runnable plan. It's stripped down to the parts that are **domain-independent**: the front-matter schema, the validation scripts, the ADR format, the Strangler Fig protocol, the handoff templates, and the north-star document skeleton.

## What's in here

| Thing | Where |
|---|---|
| **Traceability script** (Mermaid graph + backlinks + orphan detection) | [`scripts/traceability.js`](./scripts/traceability.js) |
| **Confluence sync script** (comments + status labels → Git) | [`scripts/confluence-sync.js`](./scripts/confluence-sync.js) |
| **5 handoff templates** (PR, code review, runbook, dashboard spec, readiness) | [`docs/handoff/`](./docs/handoff/) |
| **3 methodology ADRs** (Strangler Fig, Dev Harness, Product Decision Log) | [`docs/adr/`](./docs/adr/) |
| **North-star document skeleton** (10 chapters + appendix) | [`docs/templates/`](./docs/templates/) |
| **Module migration playbook template** (12 sections) | [`docs/templates/module-playbook-template.md`](./docs/templates/module-playbook-template.md) |
| **Fictional worked example** (AcmeAds) | [`examples/acme-ads/`](./examples/acme-ads/) |
| **Docs site** (Docusaurus, EN + zh-TW) | [`docs/`](./docs/) |

## Quick start

```bash
git clone https://github.com/hanfourhuang/pm-workspace-kit.git my-workspace
cd my-workspace
npm install

# Validate front-matter on your docs
npm run traceability:check

# Regenerate the dependency graph
npm run traceability:matrix

# Serve the docs site locally
npm start
```

## Adopting the kit for your project

1. Copy `scripts/`, `docs/handoff/`, `docs/templates/`, and `docs/adr/` into your repo
2. Drop [`.github/workflows/traceability-check.yml`](./.github/workflows/traceability-check.yml) into your `.github/workflows/`
3. Read [Getting Started](./docs/getting-started.md) to set up front-matter on your first PRD
4. (Optional) Wire [Confluence sync](./docs/guides/confluence-sync.md) if your org publishes to Confluence

## Design principles

1. **Git is the single source of truth.** Everything worth arguing about lives in markdown with front-matter.
2. **Content and framework are separable.** You bring your domain; the kit provides the structure.
3. **Traceability has teeth.** The check runs in CI, not in someone's head.
4. **Human decisions deserve their own file type.** ADRs for technical choices, ADRs for product decisions, both first-class.
5. **Migration is a protocol, not a heroic effort.** The Strangler Fig template gives you four named stages and quantitative exit criteria.

## Languages

The docs site is available in **English** (primary) and **繁體中文**. The framework itself is language-agnostic — use whatever your team works in for your actual content.

## License

[MIT](./LICENSE). Use it, fork it, strip it, relicense your internal content however you like. Attribution appreciated but not required.

## Origin

Extracted from a real internal PM workspace used for an ERP migration project. The content was domain-specific; the kit here is the 70% that wasn't.
