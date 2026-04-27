---
doc_id: PRD-2026-0005
title: pmk gateway — Slack-first chat surface for stakeholders
owner: "@hanfour"
status: Draft
date: 2026-04-27
related:
  requirement: []
  plan: []
  spec: []
  architecture: []
  adr:
    - ADR-0006
  module:
    - packages.cli
  confluence_page_id: null
---

# pmk gateway — Slack-first chat surface for stakeholders

## 1. Executive Summary

CLI is the wrong primary surface for non-developer PMs and stakeholders. Web (`pmk serve`) is friendlier but still requires a URL, login, and a separate UI to learn. Slack / LINE solves all of those in one move: the bot host (the engineer-PM running pmk) starts a gateway on their own machine; everyone else uses pmk by **DMing or @-mentioning a bot** in the Slack workspace they're already in. No install, no auth screen, no new UI — they keep using the chat tool they already use eight hours a day.

v0.7.0 ships Slack first (Socket Mode, no public URL needed). LINE follows in v0.7.x.

## 2. Problem Definition

- **Current pain**
  - PMs and SAs who could benefit from pmk's case files / PKB-grounded chat won't install a CLI.
  - Even a localhost web UI requires the host to provision per-stakeholder access, share a URL, manage auth.
  - Onboarding a new collaborator (ad-hoc bug investigation, stakeholder review of a PRD) currently means "first install pmk and learn 11 verbs" — that bar kills adoption.

- **Desired outcome**
  - Anyone in the host's Slack workspace can interact with pmk by DMing the bot or @-mentioning it in a channel.
  - The host (one person) installs / configures / pays the LLM bill; everyone else "just chats."
  - Channel-based collaboration: a whole engineering team can debug a bug together in one Slack thread, with case state shared.

## 3. Goals & Success Metrics

| Goal | Metric | Target |
|---|---|---|
| Reduce stakeholder onboarding cost | Time from "send invite" to "first useful pmk-grounded answer" | ≤ 2 minutes (vs current 30+ for CLI install) |
| Preserve mra integration | A stakeholder DM that names a repo gets a PKB-grounded answer | 100% of repos with `.mra/pkb/` |
| Honest offline UX | Slack bot presence reflects real host status; users always know if the host is reachable | bot presence away within 30s of host shutdown |
| Channel collaboration unlock | Number of cases collaborated on by ≥2 distinct Slack users in v0.7.0 dogfood | ≥ 1 within first week |
| Token attribution clarity | After v0.7.0 ships, host can see per-user message count | available via `pmk gateway stats` |

## 4. Non-Goals

- pmk gateway is **not** a SaaS. It runs on the host's laptop / desktop. No multi-tenant, no user accounts (Slack workspace membership is the only authn).
- pmk gateway is **not** a Slack app marketplace listing. v0.7.0 expects the host to manually create a private Slack app for their own workspace.
- Per-user API key override (`/setkey`) is **not** in v0.7.0 — host's Claude Code OAuth is shared by all users. Cost containment is host-managed (block heavy users via `/blocklist`).
- LINE / Discord / Teams are **deferred** to v0.7.x. Adapter abstraction is in v0.7.0 so they're cheap to add.
- 24/7 uptime is **not** promised. When the host's machine sleeps, the bot is offline. Bot presence reflects this honestly; no caffeinate / launchd hacks ship by default.

## 5. User Stories

**US-01 — Stakeholder DMs the bot to ask a docs question**
> As a non-engineering stakeholder, I DM `@pmk-bot` in our Slack: "What does PRD-2026-0003 say about rollback?" The bot replies with a grounded answer citing the PRD. I never installed anything.

**US-02 — Engineering team collaborates on a bug in a channel**
> As a PM, I @-mention the bot in `#oss-debug`: `@pmk-bot open cue-checkbox`. The bot creates a channel-scoped case. Three engineers and the PM all post observations into the thread; the bot tracks hypotheses, evidence, and next-questions automatically. Anyone can `@pmk-bot show` to see current state.

**US-03 — Host shuts laptop, bot goes offline transparently**
> As the bot host, I close my laptop. Within 30s, my bot's Slack presence shows as away; users who try to DM see "active 3 minutes ago." When I reopen, the bot reconnects, replays queued messages, and replies normally — with a one-line note "I was offline from `<X>` to `<Y>`" on the first reply per thread.

**US-04 — Host sees who's using pmk**
> As the host, `pmk gateway stats` shows me per-user message count and cumulative token estimate over the last 7 days. I can `/blocklist <userId>` if someone abuses it.

## 6. Functional Requirements

- **Must have**
  - `pmk gateway init` — interactive setup; prompts for Slack app token (xapp-) + bot token (xoxb-), writes `~/.pmk/gateway.json`.
  - `pmk gateway start` — foreground process; connects via Slack Socket Mode (no public URL), accepts SIGINT for clean shutdown, broadcasts an offline notice to recent DM partners + active channel cases.
  - `pmk gateway status` — reports running / stopped, last heartbeat, Slack workspace name.
  - DM personal session: each Slack user has one persistent session at `~/.pmk/gateway/slack/users/<userId>/session.json`; chat history persists across host restarts.
  - DM personal cases: `~/.pmk/gateway/slack/users/<userId>/cases/<name>.json`; same surface as `pmk case` (auto-tracking from natural conversation).
  - Channel-shared cases: when bot is `@`-mentioned in a channel, case state lives at `~/.pmk/gateway/slack/channels/<channelId>/cases/<name>.json` and is visible to anyone in that channel.
  - Slash commands inside Slack (DMs and channel mentions): `/pmk show`, `/pmk open <name>`, `/pmk close <name>`, `/pmk help`. Implemented via Slack message text parsing (no Slack slash-command app config required for v0.7.0).
  - Sleep / offline UX: heartbeat file at `~/.pmk/gateway/heartbeat`; on startup, if the heartbeat is > 60s stale, broadcast "I was offline, back now" to recent threads. Bot presence set to active on connect, away on graceful exit.
  - Auto-ingest: gateway respects `~/.pmk/gateway.json::default_ingest` (e.g. `mra:--all`) so every new session has PKB context without per-user setup.

- **Should have**
  - `pmk gateway stats` — message count + cumulative token estimate per Slack user, last 7 days.
  - `/blocklist <userId>` and `/unblocklist <userId>` for the host (not other users) to throttle abuse.
  - Concurrent in-flight cap (e.g. 3 simultaneous LLM calls; 4th queues with "thinking…" indicator).
  - `pmk gateway logs` — tail recent activity log without leaving terminal.

- **Could have**
  - Token-streaming via Slack message edits at 2-3 second intervals (rate-limited to stay within Slack API limits).
  - Slack thread → pmk case mapping: a thread under a channel post becomes a case automatically.
  - Image / file attachments: stakeholder can drop a screenshot in DM, gateway forwards to LLM as image.

- **Won't (this release)**
  - LINE adapter (v0.7.2)
  - Per-user `/setkey` API key override (v0.7.1+ if cost is real)
  - SaaS / hosted multi-tenant
  - Mobile app (Slack mobile already covers this)

## 7. Risks

- **Host machine sleep reduces availability** — accepted; transparency via bot presence + offline broadcast is the mitigation. *Revisit if* > 50% of stakeholder messages get "host offline" delays.
- **Token costs escalate as more users come on** — host pays everything in v0.7.0; if cost gets real, ship `/setkey` in v0.7.1.
- **Slack app config friction** — manual Slack app creation is annoying. Documented step-by-step in README; consider a one-click manifest in v0.7.x.
- **mra PKB grows stale across multiple users' use** — same warning system as ingest mra: in v0.5.2 (per-repo `mra analyze` reminder, 7-day threshold).
- **Privacy: bot has access to host's mra workspace** — fine within an org (Slack workspace = trust boundary), but document explicitly that bot replies may surface code snippets. <!-- TODO(owner): add an `--allow-paths` filter to the mra adapter for v0.7.x -->

## 8. Open Questions

1. Should channel cases be auto-created on first `@`-mention, or require explicit `@bot open <name>`? *Lean*: explicit, so users opt in.
2. When a Slack user is in multiple channels with the bot, and DMs the bot, does the DM session see DM-only state, or also channels they're in? *Lean*: DM-only — channel cases stay channel-scoped.
3. Heartbeat granularity — 30s or 60s? *Lean*: 30s; matters when host laptop dips into sleep briefly.
4. Should `pmk gateway` refuse to start if `mra doctor` fails, or run with a warning? *Lean*: warn-only; gateway works fine without mra (just no PKB grounding).
5. What happens on host reboot mid-conversation (user sent message, host crashes before response)? *Lean*: on next start, gateway's heartbeat-stale check triggers a broadcast; the user's pending message is replayed by Slack and answered normally.
