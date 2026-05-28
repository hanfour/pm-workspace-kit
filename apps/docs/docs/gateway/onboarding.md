---
sidebar_position: 2
---

# Gateway onboarding (30 minutes)

The goal: from a clean checkout to **the bot answering your first
question in Slack in under 30 minutes**, without reading the source.

This is the host-side setup. Once it's done, the people you support
just DM or `@`-mention the bot — they install nothing. The full
runtime behaviour is in the [gateway lifecycle](./lifecycle.md)
deep-dive; this page is the install rail. The product rationale is in
[PRD-2026-0006](../prds/2026-05-gateway-onboarding-prd.md).

## Prerequisites

- Node.js ≥ 20, the repo cloned, `npm install` run, `npm run cli:build` done.
- A Slack workspace where you can create an app (admin or "anyone can
  create apps" enabled).
- An Anthropic API key.
- (Optional, for code-aware answers) an [`mra`](https://github.com/hanfour/multi-repo-agent)
  workspace. Without it the gateway still answers from your markdown
  PKB — see base vs. mra-enhanced value in the README.

## The six steps

Each step is budgeted at ~5 minutes.

### 1. Create the Slack app from the manifest (5 min)

1. Open [api.slack.com/apps?new_app=1](https://api.slack.com/apps?new_app=1) → **From a manifest**.
2. Pick your workspace.
3. Paste the contents of `packages/cli/src/gateway/slack/manifest.template.json`
   (or the raw URL printed by `pmk gateway init`).
4. Review → **Create**. The manifest wires all 7 bot scopes, 3 bot
   events, and Socket Mode in one shot — no manual scope-by-scope
   clicking.

### 2. Grab the two tokens (5 min)

After the app is created:

- **App-Level Token** (`xapp-...`): App settings → **Basic Information**
  → App-Level Tokens → generate one with `connections:write`. (Socket
  Mode needs it.)
- **Bot User OAuth Token** (`xoxb-...`): **OAuth & Permissions** →
  Install to Workspace → copy the bot token.

### 3. Write the config (5 min)

```bash
pmk gateway init
```

Paste both tokens when prompted, plus (optionally) your `mra` workspace
path and a default ingest spec (`mra:--all` is typical). This writes
`~/.pmk/gateway.json` at mode 0600. `init` also prompts for your
Anthropic API key so the gateway can use the direct API provider.

### 4. Pre-flight with doctor (5 min)

```bash
pmk gateway doctor
```

`doctor` is read-only — it never writes config or posts to Slack. It
checks the config file, both Slack tokens, the Anthropic key, the mra
workspace, your PKB source, channel ACLs, and that the repo-side
manifest still matches what the runtime expects. Every failure prints
a one-line hint. Fix anything red and re-run until you get:

```
Summary: N pass, … warn, 0 fail
```

`WARN`s are non-fatal (e.g. "no channels configured; bot will only
respond in DMs"). `pmk gateway doctor --json` emits the same report
for CI or a pre-start hook.

### 5. Seed + dry-run (5 min)

Seed one known atom so retrieval has something to hit:

```bash
pmk gateway demo seed
```

Then exercise the whole retrieval → LLM → escalation path **without
sending anything to Slack**:

```bash
pmk gateway start --dry-run
```

Dry-run wraps the Slack client at the outermost layer: every
`postMessage` / `reaction` is logged to stderr as `[dry-run] …`
instead of being sent, and events go to `dryrun-events-YYYY-MM.log`
so your real audit log stays clean. DM the bot in Slack — you'll see
the would-be reply printed in your terminal, nothing posted. Ctrl+C
prints a session-metrics summary. This is the step where you catch a
broken prompt or a missing mra workspace **before** a stakeholder
ever sees the bot.

### 6. Go live + first message (5 min)

```bash
pmk gateway start
```

In Slack, DM the bot (or `@`-mention it in a channel you've added via
`pmk gateway audience set-channel <channelId> <tier>`) with:

> pmk gateway 是什麼？

You should see the bot quote the demo answer. That round-trip means
the loop works. Clean up the smoke-test atom whenever you like:

```bash
pmk gateway demo unseed
```

## If something's wrong

- **Re-run `pmk gateway doctor`** — it catches the common failures
  (expired token, missing scope, unreachable mra workspace, empty PKB,
  drifted manifest) with an actionable hint each.
- **Re-run with `--dry-run`** to reproduce a misbehaving answer
  without spamming the channel.
- Token rotated or scopes changed? Re-run `pmk gateway init`, then
  `pmk gateway doctor` to confirm.

## Where this sits in the 30-day path

Onboarding is the **Week 1** milestone in the README adoption path.
By Week 2 you run the full knowledge loop end-to-end (ask → `mra-ask`
→ escalation → absorb → reuse), walked through in the
[gateway lifecycle](./lifecycle.md).
