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

## Secrets without plaintext

By default `pmk gateway init` stores your Slack tokens and Anthropic key as literal strings in `~/.pmk/gateway.json` (mode 0600). If you want the file to carry no secret material at all — for example, so a Time Machine backup or a disk image doesn't capture a live token — you can replace any of the three secret fields with a **reference** after running `init`:

```json
{
  "slack": {
    "appToken": { "cmd": "op read op://Personal/Slack/app-token" },
    "botToken": { "env": "MY_SLACK_BOT_TOKEN" }
  },
  "apiKey": { "cmd": "vault kv get -field=value secret/anthropic/key" }
}
```

Two reference forms are supported:

- **`{ "cmd": "…" }`** — pmk runs the command via `sh -c` (10 s timeout) and uses the trimmed stdout as the secret. Any CLI secret manager that can print a value works: 1Password (`op read`), HashiCorp Vault, AWS Secrets Manager, `pass`, etc.
- **`{ "env": "VAR_NAME" }`** — pmk reads that environment variable at startup.

**Precedence** (highest wins):

| Secret | Override order |
|---|---|
| `slack.appToken` | `PMK_SLACK_APP_TOKEN` env → `{cmd}`/`{env}` reference → literal |
| `slack.botToken` | `PMK_SLACK_BOT_TOKEN` env → `{cmd}`/`{env}` reference → literal |
| `apiKey` | `ANTHROPIC_API_KEY` or `~/.pmk/config.json` apiKey → `{cmd}`/`{env}` reference → literal |

A fixed-name env override (`PMK_SLACK_APP_TOKEN` / `PMK_SLACK_BOT_TOKEN`), if set to **any** value — including an empty string — short-circuits the reference, which is then never run. (Note: an empty value is still subject to the `xapp-`/`xoxb-` format check, so it won't let the gateway start with a blank token.) Similarly, a non-empty CLI-config key means the gateway `apiKey` `{cmd}` never runs.

**Re-running `init` preserves references.** If you press Enter past a token prompt, the existing reference stays on disk unchanged. Only a newly typed literal replaces it.

**`pmk gateway doctor` shows each secret's source:**

```
[PASS] secret-sources — slack.appToken: disk=cmd effective=cmd; slack.botToken: disk=env:MY_SLACK_BOT_TOKEN effective=env:MY_SLACK_BOT_TOKEN; apiKey: disk=literal effective=literal; no literal secret sources in gateway.json
```

If a reference is the effective source but can't produce a value (command exits non-zero, env var unset), `doctor` exits 1 with a message naming the secret and exit code — never the command's output. Fix the reference and re-run `doctor` before starting the gateway.

> **Scope note:** the "no literal secret sources" note appears when none of the three secret fields is a literal string — i.e. each is either a `{cmd}`/`{env}` reference or unset. The check covers `gateway.json` only. A `~/.pmk/config.json` `apiKey` is out of scope and may still be plaintext.

## Operating the gateway

Once the bot is live you will reach for these commands to inspect it,
stop it cleanly, restart it after a config change, or keep it running
persistently as a macOS LaunchAgent.

### Three layers of state to keep straight

| State | What it means | How to check |
|---|---|---|
| **installed** | The LaunchAgent plist is on disk (`~/Library/LaunchAgents/com.pmk.gateway.plist`) | `pmk gateway install-service` wrote it |
| **loaded** | The plist is registered with launchd (`launchctl print` succeeds) | `launchctl print gui/$(id -u)/com.pmk.gateway` (note: `pmk gateway status` shows `supervised: launchd` only for a *live supervised process*, not a loaded-but-stopped service) |
| **live** | A gateway process is actually running and the Slack socket is connected | `pmk gateway status` + `/pmk admin doctor` |

A service can be installed but not loaded (e.g. after `pmk gateway stop`). A
service can be loaded but not live if launchd is between restart attempts.
These distinctions drive the `stop` and `restart` decision trees below.

### `pmk gateway status`

Reads persisted state from disk — no live socket access required. Works
even when the gateway is down.

```
pmk gateway status
```

**Example output:**

```
pmk gateway status
🟡 degraded — process + heartbeat ok, live socket unknown — see /pmk admin doctor
  running:    yes (pid 12345)
  supervised: launchd (com.pmk.gateway)
  heartbeat:  8s ago
  uptime:    3620s
  turns/30m: 14
  last offline reason: —
  mra workspace: /Users/you/work
  live socket: use `/pmk admin doctor` in Slack
```

**Why `status` caps at 🟡 (never 🟢):** the CLI reads only files on
disk and cannot see inside the live process. It can confirm the pid is
alive and the heartbeat is fresh, but cannot confirm the Slack Socket
Mode connection. For a 🟢 healthy verdict you need `/pmk admin doctor`,
which runs *inside* the daemon and has direct access to the socket and
watchdog state.

**Verdict legend:**

| Emoji | Level | Condition |
|---|---|---|
| 🔴 | down | pid dead or heartbeat stale (≥ 60 s) |
| 🟡 | degraded | pid alive + fresh heartbeat, but socket unconfirmable from CLI |
| 🟢 | healthy | only reachable via `/pmk admin doctor` (live socket confirmed) |

`status` never resolves `{cmd}` or `{env}` secret references in
`gateway.json` — it reads raw config for metadata only.

### `pmk gateway stop`

Stops the gateway cleanly. Auto-detects whether the process is
supervised by launchd and takes the appropriate path.

```
pmk gateway stop
```

**Decision tree:**

1. **launchd-supervised** (run-state says `supervised: launchd`, or the
   service is currently loaded) → `launchctl bootout gui/<uid>/com.pmk.gateway`
   — launchd tears down the unit; KeepAlive is suspended until next load.
2. **Not running, no plist loaded** → prints "gateway is not running."
   with no side effects.
3. **Standalone process** → sends `SIGTERM` then polls every second for
   up to 30 seconds, confirming the pid is gone. The gateway drains
   in-flight turns before exiting (25 s budget).

If a plist is installed on disk but is already booted-out, `stop` does
not issue a redundant `bootout`.

### `pmk gateway restart`

Restarts the gateway. Like `stop`, it auto-detects the supervision mode.

```
pmk gateway restart
```

**Decision tree:**

1. **Service loaded in launchd** → `launchctl kickstart -k gui/<uid>/com.pmk.gateway`
   (terminates the old unit and starts fresh in one step).
2. **Plist installed but NOT loaded** → `launchctl bootstrap gui/<uid> <plist>`
   (RunAtLoad brings it up). `kickstart` on an unloaded service would error —
   this is why `restart` uses `bootstrap` here, not `kickstart`.
3. **Standalone** → `SIGTERM` the live process, then spawns a detached
   `gateway start`, then polls the run-state file until the new process
   writes `phase: "ready"` — confirming Slack is connected, not just
   that the process started (`phase: "starting"` is written earlier and
   must not be mistaken for success). Times out after 15 s with a hint
   to check `~/.pmk/logs/gateway.err.log`.

### `/pmk admin doctor` (Slack)

A Slack slash command for admins that runs **inside the live daemon** and
reports real-time socket and watchdog state. Because it executes in the
same process as the Slack connection, it can confirm what `pmk gateway status`
cannot.

```
/pmk admin doctor
```

**Example reply:**

```
🟢 *gateway healthy* — connected
• socket: connected (pong-timeouts 0, unstable 0s)
• watchdog: 0 flaps, 0 confirmed-fail
• heartbeat: 6s ago
• uptime: 3624s
• turns/30m: 14
```

The snapshot is read at command time (not captured when the daemon
started), so repeated calls always reflect the current connection state.

**DM-only, admin-restricted.** You must be in `gateway.json`'s `admins`
list to run admin commands. The first admin is bootstrapped with
`pmk gateway init`; subsequent admins are added via
`/pmk admin admins add @user`.

### `pmk gateway install-service`

Installs a macOS LaunchAgent so the gateway starts automatically at
login and restarts after crashes (KeepAlive).

```bash
# Write the plist only (inspect before loading):
pmk gateway install-service

# Write and load in one step:
pmk gateway install-service --load

# Overwrite an existing plist:
pmk gateway install-service --force

# Remove the plist and unload the service:
pmk gateway install-service --uninstall
```

**What it generates:**

- `~/Library/LaunchAgents/com.pmk.gateway.plist` with `KeepAlive: true`
  and `RunAtLoad: true`.
- Logs to `~/.pmk/logs/gateway.out.log` / `gateway.err.log`.
- Sets `PMK_SERVICE=launchd` and `PMK_SERVICE_LABEL=com.pmk.gateway` in
  `EnvironmentVariables` so the gateway knows it is supervised.
- `WorkingDirectory` is set to `mraWorkspace` if valid, otherwise `cwd`
  at install time — mra-ask needs this to find `.collab/repos.json`.

**No secrets in the plist.** Tokens are never written to the plist. They
stay in `~/.pmk/gateway.json` via the v0.20.0 secret-references mechanism
(`{cmd}` / `{env}` / literal). The LaunchAgent inherits `HOME` and a
sanitised `PATH`, but nothing else from your shell.

**`{env}` secret caveat.** If any of `slack.appToken`, `slack.botToken`,
or `apiKey` in `gateway.json` uses an `{env}` reference,
`install-service` will print a warning:

```
⚠️  slack.appToken is an {env:MY_APP_TOKEN} reference — the LaunchAgent
     has no such env; use a {cmd} ref / literal, or add it to the plist yourself.
```

A LaunchAgent's `EnvironmentVariables` dict is the only environment it
sees — your shell's exported variables are not inherited. Use a `{cmd}`
reference (e.g. `op read`) or a literal value instead, or add the
variable manually to the plist's `EnvironmentVariables` dict.

**Loading manually (if you did not pass `--load`):**

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pmk.gateway.plist
launchctl enable gui/$(id -u)/com.pmk.gateway
```

## Reading uploaded files

Attach files to a DM or @-mention and the bot reads them as reference context for
that thread. Supported: text/markdown/code, PDF, and images (PNG/JPEG/GIF/WebP,
read via Claude vision — needs the `ANTHROPIC_API_KEY` provider). Content persists
for the whole thread; reply in the same thread to keep referencing it.

**One-time setup:** attachments need the `files:read` scope, which is new — after
updating, **reinstall the Slack app** (re-run the manifest/oauth flow) or downloads
fail with a "needs files:read" notice. Limits: 10 MB/file, 5 MB/image, 10 files per
message; images are read once and kept as a text description (pixel detail isn't
retained for follow-ups); linked Google/Box files and Office formats aren't supported.

## Where this sits in the 30-day path

Onboarding is the **Week 1** milestone in the README adoption path.
By Week 2 you run the full knowledge loop end-to-end (ask → `mra-ask`
→ escalation → absorb → reuse), walked through in the
[gateway lifecycle](./lifecycle.md).
