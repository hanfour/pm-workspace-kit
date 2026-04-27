---
doc_id: ADR-2026-0006
title: pmk gateway — host-machine bot for Slack/LINE, not SaaS
owner: "@hanfour"
status: Accepted
date: 2026-04-27
related:
  prd:
    - PRD-2026-0005
  module:
    - packages.cli
  confluence_page_id: null
---

# ADR-0006 — pmk gateway runs on the host machine; chat surfaces are Slack/LINE bots, not a hosted SaaS

## Status

**Accepted** — 2026-04-27.

## Context

After v0.6.0 (case files + auto-tracking), pmk's CLI surface is functionally complete for a single power user. The next gap is reach: how do non-engineering stakeholders, or fellow PMs who never touch a terminal, benefit from pmk-grounded conversations against the host's mra-indexed codebase?

Three options surfaced:

- **A. Web app at a public URL (SaaS).** Sign up, sign in, chat. Maximum reach.
- **B. Localhost web app (`pmk serve`).** Host runs `pmk serve`, opens browser to `localhost:8421`. Minimum infra; loses cross-machine access without a tunnel.
- **C. Chat-platform bot.** Host runs `pmk gateway`; other users interact via Slack / LINE / Teams. The chat platform itself becomes the UI.

## Decision

Adopt **Option C**: pmk gateway runs on the host's machine and bridges to existing chat platforms (Slack first, LINE next). v0.7.0 ships the Slack adapter using Socket Mode.

Concretely:

- pmk gateway is a long-running process started by the host (`pmk gateway start`).
- It connects out to Slack via Socket Mode, so no public URL or tunnel is required — works behind NAT, on home WiFi, on coffee-shop WiFi.
- All LLM calls go through the host's existing `resolveProvider` (Claude Code OAuth by default).
- Per-user state lives under `~/.pmk/gateway/slack/users/<userId>/`; channel state under `~/.pmk/gateway/slack/channels/<channelId>/`.
- mra integration is unchanged — it works because the gateway runs on the host machine that has the repos.

## Consequences

### Positive

- **Zero install for stakeholders**. They use Slack, which they already use.
- **Slack workspace membership = authn**. No login screen, password reset, account management.
- **mra still works**. Repos are on the host; gateway is on the host; no remote-execution problem.
- **No infra cost / SaaS billing**. Host pays for their own LLM (their existing Claude Code OAuth) and runs the gateway on hardware they own.
- **Same packages reused**. `@pmk/cli/{llm, case, adapters/mra, session}` all work without modification.
- **Mobile is solved for free**. Slack has iOS / Android apps; the bot is reachable from anywhere the user already has Slack.

### Negative

- **Availability is bounded by the host's uptime.** If the laptop sleeps, the bot is offline. We surface this via Slack bot presence + offline broadcast on graceful shutdown, but a user messaging at 3am gets no immediate response. Acceptable for an internal-team tool; not for a customer-facing product.
- **Single point of failure.** The host's machine is the bottleneck. No redundancy.
- **Token cost concentration.** All users' messages go through the host's Claude Code OAuth. v0.7.0 has no per-user accounting; v0.7.1+ may add `/setkey`.
- **Slack app setup friction.** Each host must manually create a private Slack app, enable Socket Mode, copy two tokens. Not a one-click experience.
- **Privacy boundary is the Slack workspace.** Bot replies may surface code snippets, ADR contents, PRD drafts. Anyone the host adds to the workspace gets the same access. Documented in PRD §7.

### Trade-off vs Option A (SaaS)

Rejected because:

- **mra integration breaks.** mra needs filesystem access to the user's repos; SaaS server can't have that without the user uploading code (a non-starter).
- **Auth, billing, multi-tenant DB, SLA, security audit** — all become real product / business obligations. Out of scope for an open-source PM tool maintained by one person.
- **The user explicitly chose Slack/LINE over SaaS** when this was raised — preference for "host I trust runs the bot in our chat" over "trust a third party with our PRDs."

### Trade-off vs Option B (localhost web)

Rejected because:

- **Localhost web UI is single-user.** Other PMs can't reach `http://your-laptop.local:8421` without you tunneling, which is more work than Slack.
- **Slack is already on every stakeholder's phone.** A web URL is one more app surface.
- **Web UI requires building & maintaining a SPA.** Slack adapter is a backend-only effort; the UI is Slack itself.

That said, localhost web is **not foreclosed** — `pmk serve` may still ship later for offline-laptop use, but it's not the primary surface.

## Implementation reference

- PRD: PRD-2026-0005 — pmk gateway
- New: `packages/cli/src/gateway/` — slack adapter, session store, case router, formatters
- New verb: `pmk gateway init|start|status|stats|logs`
- Config: `~/.pmk/gateway.json`
- State: `~/.pmk/gateway/slack/{users,channels}/<id>/`

## Revisit triggers

This decision should be revisited if:

- A non-OneAD audience (or multi-org use) becomes plausible — at that point the SaaS calculus changes and we may need a hosted variant.
- Host uptime becomes a real complaint (>50% of stakeholder messages hit "host offline"). v0.7.x can ship a thin always-on relay (small VPS) that proxies Slack events to the host when it's awake and queues them otherwise.
- A chat platform we haven't accounted for becomes important to stakeholders (e.g. WeCom, KakaoTalk). Adapter abstraction in v0.7.0 should make adding one a 1-2 day task, not a redesign.
