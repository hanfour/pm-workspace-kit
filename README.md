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
npx pmk gateway audience set-channel <channelId> exec  # (v0.11, #23) per-channel default; per-user override still wins
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

## Latest release: v0.13.3 (2026-05-20)

The v0.7.x series matured the Slack gateway through real dogfood; v0.8.x built retrieval quality and an in-Slack approval loop on top; v0.9.0 brought the operator surface into Slack; v0.9.1 closed the last UX gap by registering `/pmk` as a real Slack slash-command; v0.10.0 turned both kinds of observability on — `pmk gateway audit` for historical knowledge-loop telemetry, and live mra-ask progress streaming so the 30–90s round shows movement in Slack; v0.10.1 ties off two trailing items (workspace `package.json` version sync + a 10 MiB cap on `runMraAsk` stdout) before v0.11 opens; v0.11.0 brought gateway presence, per-channel audience tier, and monthly-partitioned `events-YYYY-MM.log` (closing the unbounded growth TODO); v0.11.1 hardened `msg_too_long` with a three-layer defense (pre-call prune, write-time `PMK_SEED_CAP` / `PMK_MRA_RESULT_CAP`, typed `PmkContextTooLongError` + auto-force-prune + retry) and added a `Context safety` audit section; v0.12.0 soft-flips the default provider to `anthropic-api` so `claude-agent-sdk` host context is no longer a budget unknown, restores cap headroom, and emits a `token.usage` event that rolls up into a new `Token usage` audit section; v0.12.1 catches the README up two minor versions and stops `pmk --version` hardcoding `0.7.0-dev` (now reads from the CLI manifest, so future `bump-version.mjs` runs auto-propagate); v0.13.0 lands a 27-test `SlackGateway` integration harness, decomposes the 1708-line `SlackAdapter` monolith into focused modules across three tranches (`presence` / `envelope-dedup` / `concurrency` / `escalation` / `free-chat-turn` / `inflight-queue` — net -41%), and ships two latent multi-user bugs: per-user-per-channel `inFlight` key (different users in the same channel run in parallel), append-only `channels/<id>/messages.jsonl` (parallel writers no longer race), and a real FIFO inflight queue (rapid follow-up messages now actually queue with explicit "排入隊伍" UX instead of getting dropped behind a misleading busy notice).

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
| [`v0.10.1`](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.10.1) | **Workspace version sync + mra stdout cap** — `scripts/bump-version.mjs` keeps root + 6 sub-package `package.json#version` aligned with git tags (was stuck at `0.3.0` while tags marched to `v0.10.0`); `runMraAsk` switched to chunks + 10 MiB cap to remove latent O(n²) string-concat and unbounded-memory risk |
| [`v0.11.0`](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.11.0) | **Gateway presence + per-channel audience + monthly audit logs** — kill→restart cycles no longer broadcast spurious 重新上線; `pickAudience` gains a channel-default tier so per-channel overrides no longer require per-user config; `events.log` partitioned into `events-YYYY-MM.log` to close the unbounded-growth TODO (closes #23, #44) |
| [`v0.11.1`](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.11.1) | **Gateway `msg_too_long` hardening** — three-layer defense: pre-call `pruneSessionIfNeeded` (fixes v0.8.1 fail-loop), write-time `PMK_SEED_CAP` / `PMK_MRA_RESULT_CAP`, typed `PmkContextTooLongError` + auto-force-prune + retry with a `:scissors:` trim notice; new `Context safety` audit section rolls up `context.exceeded` / `context.force-pruned` / `message.capped` events |
| [`v0.12.0`](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.12.0) | **Gateway default provider → `anthropic-api`** (soft flip — `ANTHROPIC_API_KEY` users auto-switch, others stay on `claude-agent`) — eliminates `claude-agent-sdk` host-context as a budget unknown so cap defaults relax back to operationally useful values; new `token.usage` event (per-actor / per-model in / out / cache) feeds a new `Token usage` audit section; `gateway init` now prompts for `ANTHROPIC_API_KEY` |
| [`v0.12.1`](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.12.1) | **README + CLI version catch-up** — `Latest release` section was stuck at v0.10.1 while the tag stream marched to v0.12.0; `pmk --version` reported `0.7.0-dev` since v0.7.0 because Commander's `.version()` was a string literal — now imports `version` from `packages/cli/package.json` so `bump-version.mjs` auto-propagates to the CLI's reported version |
| [`v0.13.0`](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.13.0) | **`SlackGateway` harness + adapter decomposition + FIFO inflight queue** — 27-test integration harness (fake `WebClient` / `SocketModeClient` / LLM / mra) lands first so 3 tranches can extract `presence` / `envelope-dedup` / `escalation` / `free-chat-turn` / `inflight-queue` under a safety net (`SlackAdapter` 1708 → 1010 lines, -41%); per-user-per-channel `inFlight` key lets different users `@pmk` in the same channel in parallel; append-only `channels/<id>/messages.jsonl` removes the parallel-writer race that pre-v0.13 silently dropped turns; real FIFO queue (depth 3) replaces "drop + misleading busy notice"; graceful shutdown drains queued turns (25 s budget) so kill no longer abandons in-flight work |
| [`v0.13.1`](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.13.1) | **Gateway audience: flip default `tech` → `pm`** — same-day v0.13.0 dogfood surfaced that non-IT teammates were getting engineer-grade replies (file paths, API names, `dynamic dispatch` callouts) because `defaultAudience()` returned `tech` for unknown users. Typical pmk-gateway workspaces are PM/ops majority; `pm` (structural findings, jargon translated, PM-framed questions back) is the better default. IT users opt in via per-user override |
| [`v0.13.2`](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.13.2) | **Gateway audience: re-flip default `pm` → `biz`** — v0.13.1 dogfood (~30 min after ship) showed PM tier still cites file paths and method names by design (it's for "PMs who brief engineers"), leaving true non-IT users with code-flavoured replies. `biz` is the right default: mandatory jargon translation (`AdFormat` → 「廣告版型」), no code blocks unless quoting operational SQL, implementation collapsed into "想看實作可以再問 IT". PM and tech tiers stay opt-in via per-user override |
| [`v0.13.3`](https://github.com/hanfour/pm-workspace-kit/releases/tag/v0.13.3) | **Audience prompts: anti-bleed + BIZ translation table** — PM tier was still emitting Ruby code blocks in live tests (LLM tone-matching the channel's prior tech-tier history); both PM and BIZ prompts now lead with "Your tier dictates style, not conversation history". BIZ jargon cheat-sheet expanded from 3 to 9 rows covering generic Rails/web-stack terms (`Devise`/`Doorkeeper`, `Rolify`, `CanCanCan`/`ability.rb`, `scope`, `AASM`, `Sidekiq`, `migration`, `controller`, `AdFormat`) — bot is explicitly told never to leave the tech form alone in body text |

The full knowledge loop — *PM asks in Slack → bot tries PKB → escalates to mra-ask → escalates to a human IT contact → absorbs the answer → next person who asks gets the cached answer* — works end-to-end, with retrieval quality improved by BM25 (v0.8.4), in-flow ✅ approval (v0.8.5), Slack-side admin commands (v0.9.0), a properly-registered `/pmk` slash-command (v0.9.1), historical + live observability (v0.10.0), context safety hardening (v0.11.1), per-actor token attribution on the direct-API path (v0.12.0), an integration-test safety net + decomposed adapter + true FIFO queue (v0.13.0), a `biz`-tier non-IT default for the audience system (v0.13.1 → v0.13.2), and audience prompts hardened against history-bleed with an expanded jargon table (v0.13.3). Tests: 75 → **362** across the v0.7–v0.13 series. Walk through it phase-by-phase in the [Gateway lifecycle](https://hanfour.github.io/pm-workspace-kit/docs/gateway/lifecycle) deep-dive, or skim the release-by-release [changelog](https://hanfour.github.io/pm-workspace-kit/docs/changelog).

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
