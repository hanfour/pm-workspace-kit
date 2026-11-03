# PM Workspace Kit

> Write traceable PM / SA documents, investigate projects through the `pmk` CLI and Slack gateway, and edit Markdown in the desktop app.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE) [![Docs](https://img.shields.io/badge/docs-live-blue)](https://hanfour.github.io/pm-workspace-kit/) [![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](#prerequisites)

## Source and deployment status

As of **2026-11-03**, the package version in this repository's `main` source is **v0.46.1**. The quick start below describes that checked-in source.

A separate operator workspace has validated and deployed **v0.46.2** gateway updates:

- Persistent free-chat journals and bounded task cards retain goals, corrections, constraints and unknowns across follow-ups and restarts.
- Answer checks keep failed code acquisition separate from earlier PKB summaries. Source-first generation from code excerpts is opt-in.
- Human escalation carries attributed user context into knowledge extraction. Available Anthropic API usage is recorded even when a structured result is rejected.
- PRD saves use host-assigned IDs and collision-safe filenames. A portable offline continuity replay compares archived responses against a selected compiled runtime without new inference.

Those updates are **not included in the `main` source by this README-only publication**. They do not establish a new GitHub release or a live-model quality score. Their source, integration guides and private validation records are not linked here until separately published. Installing this repository currently installs the v0.46.1 source capabilities described below.

## Why this exists

Most PM tooling either lives in a wiki (search is fine, structure is fiction) or in a ticketing system (tasks are fine, rationale is absent). Neither survives a platform migration.

This kit is what we used to plan a monolith → TypeScript migration of an 11-module ERP system without writing a single line of production code, and still handing engineering a runnable plan. The core is **domain-independent**: front-matter schema, validation scripts, ADR format, Strangler Fig protocol, handoff templates, north-star skeleton. On top of that core, the kit ships a CLI (`pmk`) that turns each PM verb into a repeatable conversation, a Slack gateway so stakeholders can drive `pmk` from the messengers they already use, and a desktop GUI for the same surface.

## What's in here

The repo has three interfaces backed by shared templates and traceability tools. CLI and Slack provide the main workflows; the checked-in desktop remains an early interface.

| Interface | What it does |
|---|---|
| **Local doc/code workflow** (`pmk` CLI + templates + traceability core) | PM verbs as named conversations (`propose`, `ingest`, `apply`, `ask`, `case`, …) on top of a markdown front-matter schema, Mermaid dependency graph, Strangler Fig migration playbook, MADR ADR template, and a 5-doc handoff kit. Source: [`packages/cli/`](./packages/cli/), [`packages/core/`](./packages/core/), [`apps/docs/docs/`](./apps/docs/docs/). |
| **Slack gateway** | The host runs the bridge; team members DM or `@`-mention the bot. Closed knowledge loop: retrieval → auto `mra-ask` → human escalation → absorb → approval → future hit. Source: [`packages/cli/src/gateway/`](./packages/cli/src/gateway/). |
| **Desktop app** _(secondary)_ | Electron GUI over the same CLI surface. Still an early shell pending [Desktop PRD](https://hanfour.github.io/pm-workspace-kit/docs/prds/2026-04-24-desktop-app-prd) parity; CLI + gateway carry the core experience today. Source: [`apps/desktop/`](./apps/desktop/). |

Docs ship as a Docusaurus site (EN + zh-TW): [hanfour.github.io/pm-workspace-kit](https://hanfour.github.io/pm-workspace-kit/). A worked AcmeAds example lives in [`examples/acme-ads/`](./examples/acme-ads/).

### Base value vs. mra-enhanced value

PMK does two distinct things depending on whether [`multi-repo-agent`](https://github.com/hanfour/multi-repo-agent) (mra) is installed.

- **Base value** (no mra): traceable PM docs, PRD authoring with `pmk propose`, RAG over your `docs/`, Slack gateway answering from your markdown + PKB.
- **mra-enhanced value** (with mra): the above, plus answers grounded in real module / endpoint names from your repos, and the gateway can auto-`mra-ask` before tagging a human contact.

mra is optional for documentation and knowledge retrieval. Configure an mra workspace before relying on repository code investigation; PKB coverage alone does not prove an unseen code path.

## Quick start

### Prerequisites

- Node.js ≥ 20
- Git

### Clone + install

```bash
git clone https://github.com/hanfour/pm-workspace-kit.git my-workspace
cd my-workspace
npm ci
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
npm run build --workspace=@pmk/shared
npm run build --workspace=@pmk/rag
npm run build --workspace=@pmk/llm
npm run cli:build                  # builds packages/cli after its dependencies
npx pmk --help                     # or: npm run pmk -- --help

# Doc-authoring + investigation verbs
npx pmk propose "weekly digest"              # PRD interview under configured docsRoot/prds/
npx pmk index                               # build the docs index first
npx pmk ask "how does our auth flow work?"   # RAG over your indexed docs
npx pmk case open prod-checkout-503          # long-lived bug investigation file

# Slack gateway (v0.7+) — host-run bridge so PMs/stakeholders DM pmk in Slack
npx pmk gateway init                          # one-time: paste Slack tokens + mra workspace path
npx pmk gateway doctor                        # (v0.16) read-only pre-flight: tokens, key, mra, PKB, ACL, manifest
npx pmk gateway demo seed                     # (v0.16) write one smoke-test atom; `demo unseed` to remove
npx pmk gateway start --dry-run               # (v0.16) exercise the full path with zero Slack writes
npx pmk gateway start                         # run the bridge (foreground)
npx pmk gateway status                        # configured? running? mra workspace ok?
npx pmk gateway admin add <userId>            # (v0.9) bootstrap first Slack admin — required for /pmk admin
npx pmk gateway audience set <userId> pm      # (v0.8) tech / pm / biz / exec tone per user
npx pmk gateway audience set-channel <channelId> exec  # (v0.11, #23) per-channel default; per-user override still wins
npx pmk gateway audience example add biz SKU 商品編號           # (v0.15) workspace-specific BIZ/PM cheat-sheet additions
npx pmk gateway audience example list                           # show registered domain examples
npx pmk gateway escalation add <repo> <userId>  # IT/domain contact pool for `escalate`
npx pmk gateway atoms list --pending          # absorbed knowledge atoms awaiting promotion
npx pmk gateway atoms approve <id-prefix>     # promote a pending atom to retrieval-visible
# After bootstrap: in Slack DM with the bot, run `/pmk admin help` for the in-Slack surface (v0.9).
```

**Slack in-DM / @-mention review commands** (requires `review.enabled: true` in `gateway.json`; default provider is Codex):

- `:cr: <PR url>` — asks MRA protocol v1 for a SHA-bound analysis artifact, then PMK posts the inline GitHub review. New installs default to `codex` + `standard`; pre-provider configs retain Claude/debate until an admin migrates them. `:cr:` never submits GitHub APPROVE by itself. When automatic approval is enabled and the artifact is complete and blocker-free, it creates a one-time thread offer.
- `:a: <PR url>` — PMK-admin only. Runs the same analysis first and asks for an explicit thread `approve` confirmation; the trigger itself never approves.
- React with `:cr:` on a user's PR-link message to trigger a review without re-typing the URL.
- A PMK admin may react with `:a:` on a user's PR-link message to start review plus approval intent.
- Slack admins can switch the backend live with `/pmk admin review provider codex|claude|fallback|dual`. Automatic approval has a separate default-off kill switch: `/pmk admin review approval enable|disable`.
- Provider switching applies to review. Only Codex protocol-v1 artifacts are sanitized approval evidence; Claude/fallback/dual runs stay review-only and never create an approve offer.
- GitHub APPROVE publication currently has a release veto: admins cannot enable it until cross-process policy locking is shipped. `:cr:` and `:a:` analysis remain available and never approve on their own.

The CLI delegates code-intelligence work to [**multi-repo-agent (mra)**](https://github.com/hanfour/multi-repo-agent) when present. The gateway specifically uses three integrated mechanisms:

- **PKB seed** — first DM/channel turn loads the `mra:--all` summary set so the model grounds answers in real module names from turn one.
- **Auto-mra-ask** — when PKB isn't enough, the model emits a fenced `mra-ask` block; pmk runs `mra ask <repo>` and feeds the result back for synthesis.
- **Escalate → absorb → retrieval** — when neither PKB nor mra-ask suffices, the model emits an `escalate` block; pmk @-mentions a registered IT contact in the thread, absorbs their reply as a `KnowledgeAtom`, and retrieves it (after a 24h pending TTL or explicit `pmk gateway atoms approve`) for future similar questions.

mra is optional for the base workflows. Code investigation depends on the available workspace, PKB and mra result.

### C. Desktop app

```bash
npm run build --workspace=@pmk/shared
npm run build --workspace=@pmk/llm
npm run desktop:dev                # Electron + Vite dev mode
npm run desktop:build              # packaged app bundles
```

## Adopting the kit for your project

The fastest way to feel the value follows a time-ordered path. The early steps don't need mra; mra-enhanced value comes online in Week 2.

- **Day 1** — `pmk propose` writes a PRD into the configured `docsRoot/prds/`. Same-day output, no infra needed.
- **Day 2–3** — Author a second PRD. `traceability.js` now has links to validate; the dependency graph and orphan report start earning their keep. Drop [`.github/workflows/traceability-check.yml`](./.github/workflows/traceability-check.yml) into CI to keep them honest.
- **Week 1** — Stand up the Slack gateway against one channel. `pmk gateway init` walks tokens; `pmk gateway doctor` and `gateway start --dry-run` make the first install verifiable before live traffic (see the [onboarding guide](https://hanfour.github.io/pm-workspace-kit/docs/gateway/onboarding)).
- **Week 2** — Run the full knowledge loop end-to-end: ask → `mra-ask` → escalation → absorb → reuse. The second person to ask a previously-escalated question gets the cached answer.

You don't have to take the whole monorepo. If you want to cherry-pick:

- **Just templates + traceability** — copy [`apps/docs/docs/handoff/`](./apps/docs/docs/handoff/), [`apps/docs/docs/templates/`](./apps/docs/docs/templates/), [`apps/docs/docs/adr/`](./apps/docs/docs/adr/), and [`packages/core/`](./packages/core/) into your repo.
- **+ the CLI** — install `@pmk/cli` from the workspace, run `pmk propose` / `pmk ask` / `pmk case` against your existing docs.
- **+ the gateway** — `pmk gateway init` to wire a Slack app for your team.

Read [Getting Started](https://hanfour.github.io/pm-workspace-kit/docs/getting-started) to set up front-matter on your first PRD; the [Confluence sync guide](https://hanfour.github.io/pm-workspace-kit/docs/guides/confluence-sync) covers the Confluence loop.

## Build and verify

Build the shared, RAG, LLM and CLI workspaces in the order shown above before running workspace tests:

```bash
npm test --workspace=@pmk/shared
npm test --workspace=@pmk/llm
npm test --workspace=@pmk/rag
npm test --workspace=@pmk/cli
npm test --workspace=@pmk/core
npm test --workspace=@pmk/desktop
```

See the [test workflow](./.github/workflows/test.yml) for the checked-in CI commands. Software tests, scripted scenarios, deployed-host health and model-quality evaluations measure different things; a passing fixture is not a live Slack quality score.

## Gateway deployment

```bash
npx pmk gateway deploy <ref> --repo <repository-path> --no-activate
npx pmk gateway activate <release-name>
npx pmk gateway status
# To return to the previous code release:
npx pmk gateway rollback
```

Deployment builds the selected Git commit, not uncommitted working-tree changes. Inspect the candidate before activation. On macOS, the LaunchAgent must use `releases/current` for activation to restart the service; otherwise it only updates links. The activator checks for a different ready PID and attempts code rollback if startup fails.

Back up host data and review in-flight work before restarting. Code rollback does not restore conversation data. Keep private settings, tokens, conversation backups and raw evaluation captures outside published documentation.

## Release history

The [changelog](./apps/docs/docs/changelog.md) records the repository's release history. The separately deployed v0.46.2 operator updates are summarized at the top of this README; this publication does not synchronize that workspace's code or claim a new release tag.

## Design principles

1. **Git is the single source of truth.** Everything worth arguing about lives in markdown with front-matter.
2. **Content and framework are separable.** You bring your domain; the kit provides the structure.
3. **Traceability checks run in CI.** Broken document relationships fail validation.
4. **Human decisions deserve their own file type.** ADRs for technical choices, ADRs for product decisions, both first-class.
5. **Migrations have explicit stages.** The Strangler Fig template gives you four named stages and quantitative exit criteria.
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
