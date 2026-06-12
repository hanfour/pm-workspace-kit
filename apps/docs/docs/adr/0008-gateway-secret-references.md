---
doc_id: ADR-2026-0008
title: Gateway secret references — {cmd}/{env} instead of plaintext in gateway.json
owner: "@hanfour"
status: Accepted
date: 2026-06-05
related:
  prd: []
  module:
    - packages.cli
  confluence_page_id: null
---

# ADR-0008: Gateway secret references — `{cmd}`/`{env}` instead of plaintext in gateway.json

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** @hanfour
- **Tags:** gateway, security, secrets, config

## Context

The gateway's three secrets — `slack.appToken`, `slack.botToken`, and `apiKey` — are stored in `~/.pmk/gateway.json` (mode 0600). A backup tool, disk image, or another local process with read access to the home directory can recover them in plaintext. The file is already guarded by 0600 permissions, but a reference-based approach keeps secret material off disk entirely.

All three secrets already resolve from the environment and the environment wins: `PMK_SLACK_APP_TOKEN` / `PMK_SLACK_BOT_TOKEN` override the file in `loadGatewayConfig`; `ANTHROPIC_API_KEY` (and a `~/.pmk/config.json` `apiKey`) wins via the merged CLI config at the provider merge. An operator running the gateway under `op run` / systemd `EnvironmentFile` / Vault could already keep secrets out of the file. What was missing was a **config-level reference** in `gateway.json` itself — a way for the file to point at a secret manager without holding the plaintext — so that a hand-edited config, a re-run of `pmk gateway init`, or an unrelated edit (e.g. adding an admin) can never inadvertently materialise or re-write a plain token.

The product decision (2026-06-05) is to add that reference capability, supporting both a command reference (`{cmd}`) and an env-var-name reference (`{env}`), manager-agnostic, with zero per-manager code. The full design is in `docs/superpowers/specs/2026-06-05-gateway-secret-references-design.md`.

## Decision

`gateway.json`'s three secret fields (`slack.appToken`, `slack.botToken`, `apiKey`) may now be a literal string **or** a reference object:

```json
"slack": {
  "appToken": { "cmd": "op read op://vault/slack/app-token" },
  "botToken": { "env": "MY_BOT_TOKEN" }
},
"apiKey": "sk-ant-..."
```

The two reference forms are:

- **`{ "cmd": "<shell command>" }`** — pmk runs the command via `sh -c`, captures stdout (trimmed), and uses the result. Non-zero exit, timeout (10 s), or empty output is a hard error naming the secret and exit code — never the command's stdout or stderr (either may carry the secret).
- **`{ "env": "<VAR_NAME>" }`** — pmk reads `process.env[VAR_NAME]`. Unset or empty is a hard error.

This design is **manager-agnostic**: 1Password (`op read`), HashiCorp Vault (`vault kv get`), AWS Secrets Manager (`aws secretsmanager get-secret-value`), `pass`, or any CLI that prints a secret to stdout works with zero per-manager code.

**Well-formedness is strict.** A non-string secret value must be an object with exactly one of `env` / `cmd`, with a non-empty string value. A malformed reference (both keys, unknown keys, empty value) fails-fast at load naming the offending secret. A plain string is always a literal and is never validated as a reference.

**Precedence (highest → lowest):**

Slack tokens — resolved eagerly in `loadGatewayConfig`:
```
PMK_SLACK_APP_TOKEN / PMK_SLACK_BOT_TOKEN  (fixed-name env override)
  ↳ else resolveSecret(reference {cmd}|{env})
      ↳ else literal
```

Anthropic apiKey — resolved lazily at the provider merge via `resolveGatewayApiKey`:
```
CLI config apiKey  (ANTHROPIC_API_KEY or ~/.pmk/config.json apiKey, non-empty wins)
  ↳ else resolveSecret(gateway reference)
```

The apiKey `{cmd}` **does not execute** when the CLI config already supplies a key. This preserves today's precedence exactly and avoids running a secret-manager command unnecessarily.

**Save must not materialise references.** All gateway.json mutators (`init`, `admin`, `audience`, `escalation` — both CLI and Slack `/pmk admin`) load the **raw** on-disk shape (`loadRawGatewayConfig`) and save it back raw, so an unrelated edit (e.g. adding an admin) never resolves and re-writes a `{cmd}` reference as the plaintext token. Re-running `pmk gateway init` and pressing Enter past a token prompt preserves the existing reference; only a freshly typed literal replaces it.

**`pmk gateway doctor`** reports `disk=` (from the raw file) and `effective=` (what the runtime would actually use) per secret, and validates an unshadowed reference without leaking stdout/stderr. A broken reference causes `doctor` to exit 1.

## Consequences

### Positive
- Secrets can be kept entirely off disk: a gateway.json with three references contains no secret material even if the file is copied or backed up.
- Manager-agnostic: any CLI secret manager works without per-manager code changes.
- Back-compat: existing configs with literal tokens continue to work unchanged.
- `pmk gateway doctor` provides a verifiable "no literal secret sources in gateway.json" check for operators who want that guarantee: the PASS note appears when none of the three secret fields is a literal string — i.e. each is either a `{cmd}`/`{env}` reference or unset.
- The hard no-materialise contract (raw load/save everywhere) prevents a common class of secret-leaking bugs where a re-save overwrites a reference with the resolved value.

### Negative
- Operators who use `{cmd}` references add a startup dependency: if the secret-manager CLI is unavailable at boot, the gateway fails to start (hard error). Mitigation: `doctor` validates references in advance.
- The `{cmd}` form executes an arbitrary shell command as the gateway's Unix user. An operator who hand-edits `gateway.json` with a malicious `cmd` value can run arbitrary code. This is an operator-trust boundary: gateway.json is 0600 and only the host operator can write it.
- No caching or rotation: secrets resolve once at startup. A rotated token requires a gateway restart.

### Neutral
- The "no literal secret sources" guarantee is **gateway.json-only**. A CLI-config `apiKey` in `~/.pmk/config.json` is out of scope and may still be plaintext; `doctor` does not flag it.
- The v1 `init` UX is unchanged (paste literals or press Enter). An interactive reference wizard is deferred to phase 2.

## Alternatives Considered

### Alternative A: Native URI schemes (`op://…`, `vault://…`)
- **Pros:** more discoverable; no shell-injection surface.
- **Cons:** requires per-manager parsing and testing; a new manager means a code change.
- **Rejected because:** YAGNI — the `{cmd}` form is fully manager-agnostic with zero per-manager code. Native schemes can be added later if a real operator need emerges (listed as a non-goal in the spec).

### Alternative B: Rely on the existing env-only path (`PMK_SLACK_*`, `ANTHROPIC_API_KEY`)
- **Pros:** no schema change; operators using `op run` / systemd `EnvironmentFile` already have this.
- **Cons:** the file itself still holds plaintext unless every run is wrapped; an unattended restart (e.g. launchd agent) that loses the wrapper re-exposes the literal.
- **Rejected because:** the config-level reference lets the file carry no secret material at all, independent of the launch method.

### Alternative C: Encrypt the gateway.json file at rest (safeStorage / age)
- **Pros:** transparent to the reference shape; file is opaque even on backup.
- **Cons:** key-management complexity; desktop `safeStorage` is already used for another path; adds a new dependency; harder to inspect/debug.
- **Rejected because:** references are simpler, debuggable, and composable with any secret manager the operator already uses.

## References

- Design spec: `docs/superpowers/specs/2026-06-05-gateway-secret-references-design.md`
- Implementation plan: `docs/superpowers/plans/2026-06-05-gateway-secret-references.md`
- [ADR-0006: pmk gateway — Slack/LINE bot, not SaaS](./0006-pmk-gateway-slack.md)
- Secret resolution unit: `packages/cli/src/gateway/secret-source.ts`
- Raw/resolved config boundary: `packages/cli/src/gateway/config.ts` (`loadRawGatewayConfig`, `resolveGatewayApiKey`)
- Doctor check: `packages/cli/src/gateway/doctor-checks/secret-sources.ts`
