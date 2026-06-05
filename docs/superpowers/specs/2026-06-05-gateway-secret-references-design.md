# Gateway secret references — design

Status: approved (brainstorm 2026-06-05)
Scope: `packages/cli` gateway config only.

## Context

The gateway's three secrets — `slack.appToken`, `slack.botToken`, and the
Anthropic `apiKey` — are stored in `~/.pmk/gateway.json` in plaintext (0600).
A backup tool, disk image, or another local process can read them.

All three already resolve from the environment, and env wins:
`PMK_SLACK_APP_TOKEN` / `PMK_SLACK_BOT_TOKEN` override the file in
`loadGatewayConfig`; `ANTHROPIC_API_KEY` wins via the merged CLI config in
`slack/index.ts`. So an operator can already run the gateway under
`op run` / systemd `EnvironmentFile` / Vault and keep secrets off disk.

What's missing is a **config-level reference**: a way for `gateway.json` to
point at a secret (a command to run, or an env-var name) instead of holding
the plaintext — so the gateway pulls the secret itself at startup and the
file carries no secret material. The product decision (2026-06-05) is to add
that, supporting **both** a command reference and an env-var-name reference,
manager-agnostic, with no per-manager code.

## Goals

- gateway.json can carry a **reference** instead of plaintext for any of the
  three secrets, resolved at load.
- Manager-agnostic: 1Password, Vault, AWS/GCP, `pass`, anything that can
  print a secret — via a command — works with zero per-manager code.
- Back-compat: existing gateway.json with plaintext strings keeps working
  unchanged.
- Consumers (provider resolution, `hasValidSlackTokens`, the whole gateway)
  see a resolved `string` and need no changes.
- `doctor` makes "no plaintext on disk" verifiable.

## Non-goals (YAGNI)

- No per-manager native integration (no `op://` / `vault://` URI parsing).
- No secret caching, rotation, or refresh — resolve once at startup.
- No change to desktop app `safeStorage` or to CLI config (`pmk ask`, etc.).
- No interactive reference wizard in `gateway init` (v1 — see Init UX).

## Architecture

### Schema — `SecretSource` discriminated union

The **stored** type of each secret widens from `string` to:

```ts
type SecretSource =
  | string            // literal — back-compat; existing files unchanged
  | { env: string }   // read process.env[name]
  | { cmd: string };  // run via `sh -c`, capture stdout
```

Applied to `SlackConfig.appToken`, `SlackConfig.botToken`, and
`GatewayConfig.apiKey` **at the raw/on-disk layer only**.

**Well-formedness (strict — a malformed reference is a hard error, not
"absent"):** a non-string secret value MUST be an object with **exactly one**
of `env` / `cmd`, whose value is a **non-empty string**. These are all
malformed and MUST fail-fast at load, naming the offending secret:

- both keys present (`{ env, cmd }`) — ambiguous
- neither key / unknown keys (`{ foo: ... }`)
- empty or non-string value (`{ cmd: "" }`, `{ env: 42 }`)

Rationale: a typo in a *reference* must be loud. Silently degrading a
malformed reference to "absent" would surface as a confusing "gateway not
configured" while the operator believes the secret is wired. (This is the one
place we deliberately depart from task-B's lenient on-disk tolerance — that
leniency is for legacy *literal* data, not for reference typos that lose a
secret.) A plain string is always a literal and is never validated as a
reference.

Example `gateway.json`:

```json
"slack": {
  "appToken": { "cmd": "op read op://vault/slack/app-token" },
  "botToken": { "env": "MY_BOT_TOKEN" }
},
"apiKey": "sk-ant-..."
```

### Resolution — `resolveSecret`

New unit `packages/cli/src/gateway/secret-source.ts`:

```ts
export function resolveSecret(src: SecretSource | undefined): string | undefined
```

- `undefined` (no source at all) → `undefined`. NOT an error — absence is
  surfaced later as "gateway not configured".
- `string` → the literal.
- `{ env }` → `process.env[env]`; **unset → throw `SecretResolutionError`**.
- `{ cmd }` → run `sh -c <cmd>`, return `stdout.trimEnd()`; 10s timeout.
  Non-zero exit, timeout, or empty output → throw `SecretResolutionError`.

Rule: an *explicitly configured* reference that can't produce a value is a
misconfiguration → fail-fast (consistent for `{env}` and `{cmd}`). Only the
total absence of any source is soft.

`resolveSecret` operates on an already-well-formed source; malformed objects
are rejected earlier (see Well-formedness, caught in `normaliseRawConfig`).

### Raw vs resolved config (the load boundary)

Two load entry points, so source metadata survives where it's needed and a
re-save never materialises a secret:

- **`loadRawGatewayConfig()`** — parse + normalise + **well-formedness
  validation only**. Returns the raw shape: each secret is still a
  `SecretSource` (literal | `{env}` | `{cmd}`). **No env reads, no `{cmd}`
  execution.** This is what `init` edits and what `doctor` inspects for
  source / no-plaintext reporting, and what `saveGatewayConfig` writes.
- **`loadGatewayConfig()`** — builds on the raw load and produces the runtime
  config consumers see. It resolves **Slack tokens eagerly** (see precedence)
  so `appToken?: string` / `botToken?: string` stay resolved strings and no
  downstream consumer changes. It leaves **`apiKey` as its raw `SecretSource`**
  (resolved lazily — see precedence) so the apiKey `{cmd}` doesn't run when an
  API key is already available elsewhere.

**HARD requirement — save must not materialise secrets.**
`saveGatewayConfig` takes the **raw** sources and writes them verbatim.
`saveGatewayConfig(loadRawGatewayConfig())` MUST round-trip a `{cmd}`/`{env}`
reference back as the same reference — never as the resolved plaintext. A test
asserts this explicitly.

To make this hard to get wrong, introduce a distinct **`RawGatewayConfig`**
type (secret fields typed `SecretSource`) for the on-disk shape, separate from
the resolved runtime `GatewayConfig` that consumers use. `saveGatewayConfig`
accepts `RawGatewayConfig`; the **only** valid save payload is a raw load
(optionally edited). The resolved result of `loadGatewayConfig()` must **never**
be passed to `saveGatewayConfig` — for Slack tokens that would write the
resolved plaintext (a resolved literal is structurally a valid `SecretSource`,
so types alone can't catch it; this is the procedural guard that complements
them).

### Precedence (highest → lowest), with short-circuit

Preserves the current "env always wins" model, but the **stage** differs per
secret because apiKey precedence spans the CLI config:

**Slack tokens — resolved in `loadGatewayConfig`:**
```
PMK_SLACK_APP_TOKEN / PMK_SLACK_BOT_TOKEN   (fixed-name override)
  ↳ else resolveSecret(raw reference {cmd}|{env})
      ↳ else literal
```
The fixed-name override short-circuits **before** the reference resolves:
```ts
const appToken = process.env.PMK_SLACK_APP_TOKEN ?? resolveSecret(raw.slack.appToken);
```
so a one-off `PMK_SLACK_APP_TOKEN=...` works even if the file's `{cmd}` would
fail, and a broken reference only fail-fasts when no override is present.

**Anthropic apiKey — resolved at the provider-merge in `slack/index.ts`,
NOT in `loadGatewayConfig`:**
```
CLI config apiKey  (= ANTHROPIC_API_KEY ?? CLI-file apiKey)
  ↳ else resolveSecret(gateway raw apiKey reference)
```
i.e. `const apiKey = cliConfig.apiKey ?? resolveSecret(gatewayCfg.apiKey);`.
This preserves today's precedence exactly and guarantees the gateway apiKey
`{cmd}` **does not execute when `ANTHROPIC_API_KEY` is set**. Implementers
MUST NOT move `ANTHROPIC_API_KEY` handling into `loadGatewayConfig` (that
would change CLI-config precedence and run the `{cmd}` needlessly).

## Error handling

- `{cmd}` failure (non-zero exit / timeout / empty) → fail-fast at load with
  a clear message naming **which secret** failed and the exit code — **never
  the command's stdout** (it may be the secret).
- Resolved secrets are never logged.
- A `{cmd}` that resolves but the secret is malformed (wrong prefix) surfaces
  through the existing `hasValidSlackTokens` path, unchanged.

## doctor

`DoctorContext` must carry the **raw** secret sources (e.g. add
`secretSources` derived from `loadRawGatewayConfig()`), because the resolved
`loadGatewayConfig()` has lost the source labels for Slack tokens. Two
distinct checks:

- **Source check (reads raw only):**
  - Keep the 0600 mode check.
  - Report each secret's source: `literal` / `env:<NAME>` / `cmd` /
    `fixed-env(PMK_SLACK_*)` — derived from the raw shape, never the resolved
    config.
  - Resolve each `{cmd}`/`{env}` reference once to confirm it yields a
    non-empty value; failure → FAIL (exit 1). The error names the secret +
    exit code and **excludes stdout / the resolved value**.
  - PASS line "no plaintext secrets on disk" when none of the three is a
    `literal`.
- **Auth checks (existing):** Slack `auth.test` / LLM echo use the **resolved**
  values as today — unchanged.

`--json` output includes the **source label** per secret but MUST NOT include
any resolved value or command stdout.

## Init UX (v1 scope)

- No change to the interactive value-entry flow (still paste literals).
- Add one help line to the token prompts: "or leave blank and inject via env
  (`PMK_SLACK_*` / `op run`), or hand-edit gateway.json to use a
  `{cmd}` / `{env}` reference."
- **HARD requirement — re-running `init` must NOT rewrite a reference as
  plaintext.** Today `initCmd` does `loadGatewayConfig()` → edit →
  `saveGatewayConfig()`; with resolution that would write the *resolved*
  secret back to disk on a plain Enter. v1 fixes this: `init` loads
  **`loadRawGatewayConfig()`**, and **pressing Enter preserves the existing
  raw `SecretSource`** (literal stays literal, `{cmd}`/`{env}` stays the
  reference). Only when the user types a new literal is the source replaced.
  A test covers "edit one field, Enter past a `{cmd}` field → the `{cmd}`
  survives unchanged on disk".
- Interactive literal/env/cmd wizard → **deferred (phase 2)**; the schema +
  resolver + doctor already let an advanced operator go plaintext-free by
  hand-editing. Pure UX sugar, YAGNI for v1.

## Testing

- `resolveSecret`: literal; `{env}` set → value, unset → throws; `{cmd}`
  success / non-zero / empty / timeout (last three throw); **error excludes
  stdout** (no-leak assertion).
- Well-formedness (in `normaliseRawConfig`): `{ env, cmd }` ambiguous → throw;
  `{}` / unknown keys → throw; empty string `{ cmd: "" }` / non-string
  `{ env: 42 }` → throw. Each error names the secret. (Distinct from task-B
  legacy leniency, which still applies to literal fields.)
- Precedence + short-circuit — **Slack**: `PMK_SLACK_APP_TOKEN` set →
  `{cmd}`/`{env}` is **neither read nor executed** (assert the command/env is
  never touched, e.g. a `{cmd}` pointing at a sentinel that would throw still
  yields the override value).
- Precedence — **apiKey**: `ANTHROPIC_API_KEY` set → gateway apiKey `{cmd}`
  **does not execute**; resolution stays at the provider-merge site.
- **Save must not materialise:** `saveGatewayConfig(loadRawGatewayConfig())`
  round-trips a `{cmd}`/`{env}` reference unchanged on disk (never plaintext).
- **init preserves references:** edit one field, Enter past a `{cmd}` field →
  the `{cmd}` survives unchanged in the written file.
- **doctor:** source reporting derived from raw (independent of resolved
  config); `{cmd}` failure → FAIL; `--json` carries source label but no
  resolved value / stdout (no-leak).

## Deliverables

- `secret-source.ts` (+ tests), `config.ts` schema + resolution, doctor
  extension (+ tests), init help text, deployment doc section.
- **ADR-0008** (`apps/docs/docs/adr/0008-gateway-secret-references.md`)
  recording the decision (references over plaintext; cmd+env, manager-agnostic;
  non-goals).

## Out of scope / future

- Phase 2: interactive reference wizard in `gateway init`.
- Native `op://` / `vault://` URI schemes (only if a real operator needs them).
- Secret caching / rotation.
