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
  three secrets, resolved before runtime use (Slack tokens at load; apiKey at
  the provider merge — see Precedence).
- Manager-agnostic: 1Password, Vault, AWS/GCP, `pass`, anything that can
  print a secret — via a command — works with zero per-manager code.
- Back-compat: existing gateway.json with plaintext strings keeps working
  unchanged.
- **Slack token consumers unchanged**: `loadGatewayConfig().slack.appToken` /
  `.botToken` stay resolved `string`s; `hasValidSlackTokens` and the adapter
  are untouched.
- **One deliberate consumer change — the provider merge** in
  `slack/index.ts`: `GatewayConfig.apiKey` becomes a raw `SecretSource`
  (not a `string`), resolved there via
  `cliConfig.apiKey ?? resolveSecret(gatewayCfg.apiKey)`. This is the *only*
  site that knowingly sees the raw apiKey; everything else either ignores
  apiKey or goes through this merge.
- `doctor` makes "no literal secret sources in gateway.json" verifiable.
  (Note: this is scoped to gateway.json — a CLI-config `apiKey` in
  `~/.pmk/config.json` is out of scope and can still be plaintext.)

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
- `{ env }` → `process.env[env]`; **unset OR empty (`""`) → throw
  `SecretResolutionError`** (an explicit reference must yield a real value).
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

**Applies to EVERY gateway.json mutator, not just `init`.** All
load → edit → save paths must switch from `loadGatewayConfig()` to
`loadRawGatewayConfig()`, because each currently saves a resolved config and
would materialise a referenced secret on any unrelated edit (e.g. adding an
admin). Concretely the migration covers:

- `commands/gateway/admin.ts`, `commands/gateway/audience.ts`,
  `commands/gateway/escalation.ts` (CLI `pmk gateway admin/audience/escalation`)
- `gateway/slack/admin.ts` (Slack `/pmk admin ...`)
- `commands/gateway/ops.ts` `init`

`admin` / `audience` / `escalation` (CLI + Slack) only touch **non-secret**
fields, so on raw config they edit those fields and save the raw secret sources
untouched. `init` is the one mutator that **does** touch secret fields: it also
loads/saves raw, and may **replace** a secret source **only when the user types
a new literal** — pressing Enter preserves the existing `{cmd}`/`{env}`
reference (see Init UX). (Types only narrow the gap, not close it: a resolved
Slack literal is still structurally a valid `SecretSource`, so this is enforced
procedurally — every mutator loads raw — plus the materialisation test below,
not by the compiler alone.)

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

**Anthropic apiKey — resolved at the provider-merge, NOT in
`loadGatewayConfig`:**
```
CLI config apiKey  (= ANTHROPIC_API_KEY ?? CLI-file apiKey, i.e. ~/.pmk/config.json)
  ↳ else resolveSecret(gateway raw apiKey reference)
```
This preserves today's precedence exactly and guarantees the gateway apiKey
`{cmd}` **does not execute when the CLI config already supplies a key** — via
either `ANTHROPIC_API_KEY` **or** `~/.pmk/config.json`'s `apiKey`. Implementers
MUST NOT move this into `loadGatewayConfig` (that would change CLI-config
precedence and run the `{cmd}` needlessly).

**Single source of truth — `resolveGatewayApiKey(cliConfig, rawGatewayApiKey)`:**
extract one helper that returns `{ value, effectiveSource }` where
`effectiveSource ∈ { "cli-config", "gateway:<diskSource>" }`. `cliConfig.apiKey`
counts as "supplies a key" (→ `cli-config`, short-circuit) **only when it is a
non-empty string**; an empty/absent CLI key falls through to
`resolveSecret(rawGatewayApiKey)`. (This matches today's truthy fallback in
`slack/index.ts`, where `""` is falsy.) Both `slack/index.ts` (for the value)
and `doctor` (for the label + whether to validate the reference) call this SAME
helper, so the "does the gateway `{cmd}` run?" decision can't drift between
runtime and doctor.

## Error handling

- `{cmd}` failure (non-zero exit / timeout / empty) → fail-fast at load with
  a clear message naming **which secret** failed and the exit code — **never
  the command's stdout or stderr** (either can carry the secret; e.g. a
  manager CLI that echoes the item). The `SecretResolutionError` message is
  built from the secret name + exit code only.
- Resolved secrets are never logged.
- A `{cmd}` that resolves but the secret is malformed (wrong prefix) surfaces
  through the existing `hasValidSlackTokens` path, unchanged.

## doctor

`DoctorContext` must carry the **raw** secret sources (e.g. add
`secretSources` derived from `loadRawGatewayConfig()`), because the resolved
`loadGatewayConfig()` has lost the source labels for Slack tokens. Two
distinct checks:

- **Source check** — reports two labels per secret, because "where it lives on
  disk" and "what actually supplies it at runtime" differ:
  - `diskSource` — from the **raw** shape only: `literal` / `env:<NAME>` /
    `cmd`. Never derived from the resolved config or runtime env.
  - `effectiveSource` — what the runtime would actually use, computed the SAME
    way runtime does (Slack via the `loadGatewayConfig` short-circuit; apiKey
    via the shared `resolveGatewayApiKey` helper). It is `fixed-env`
    (`PMK_SLACK_*` set) or, for apiKey, `cli-config` (`ANTHROPIC_API_KEY` **or**
    `~/.pmk/config.json` apiKey present) when something shadows the disk
    source, otherwise `= diskSource`.
  - Keep the 0600 mode check.
  - **Reference validation mirrors runtime short-circuit:** resolve a
    `{cmd}`/`{env}` reference once to confirm a non-empty value **only when it
    is the effective source** (nothing shadowing it). When shadowed (a
    fixed-env override, or for apiKey a CLI-config key), the reference is
    reported as `diskSource: cmd (shadowed by <effectiveSource> — not
    executed)` and is **not** run — matching the runtime. Validation failure →
    FAIL (exit 1); error names the secret + exit code, **excludes stdout,
    stderr, and the resolved value**.
  - PASS line "no literal secret sources in gateway.json" keyed on
    **`diskSource`** (none of the three is `literal`). Scoped to gateway.json;
    a CLI-config `apiKey` is not in scope.
- **Auth checks (existing):** Slack `auth.test` / LLM echo use the **resolved**
  values as today — unchanged.

`--json` includes `diskSource` + `effectiveSource` per secret but MUST NOT
include any resolved value or command stdout/stderr.

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

- `resolveSecret`: literal; `{env}` set → value, **unset → throws, empty
  `""` → throws**; `{cmd}` success / non-zero / empty / timeout (last three
  throw); **error excludes both stdout AND stderr** (no-leak assertion —
  include a `{cmd}` that writes the "secret" to stderr then exits non-zero, and
  assert it appears nowhere in the thrown message).
- Well-formedness (in `normaliseRawConfig`): `{ env, cmd }` ambiguous → throw;
  `{}` / unknown keys → throw; empty string `{ cmd: "" }` / non-string
  `{ env: 42 }` → throw. Each error names the secret. (Distinct from task-B
  legacy leniency, which still applies to literal fields.)
- Precedence + short-circuit — **Slack**: `PMK_SLACK_APP_TOKEN` set →
  `{cmd}`/`{env}` is **neither read nor executed** (assert the command/env is
  never touched, e.g. a `{cmd}` pointing at a sentinel that would throw still
  yields the override value).
- Precedence — **apiKey** (via the shared `resolveGatewayApiKey` helper):
  gateway apiKey `{cmd}` **does not execute** when CLI config supplies a key —
  tested for **both** `ANTHROPIC_API_KEY` set **and** `~/.pmk/config.json`
  `apiKey` set; `effectiveSource` reports `cli-config` in each. An **empty**
  CLI apiKey (`""`) is treated as absent → the gateway reference resolves.
  Only with no usable CLI key does the reference resolve.
- doctor + runtime agree: the same `resolveGatewayApiKey` helper drives both,
  so a CLI-config key shadows the gateway `{cmd}` in doctor exactly as at
  runtime (doctor does not run a `{cmd}` the runtime would skip).
- **Save must not materialise:** `saveGatewayConfig(loadRawGatewayConfig())`
  round-trips a `{cmd}`/`{env}` reference unchanged on disk (never plaintext).
- **All mutators preserve references (representative):** with a `{cmd}`
  `appToken` on disk, run an unrelated edit through each mutator family — CLI
  `audience set` / `admin add` / `escalation add` and the Slack `/pmk admin`
  path — and assert the `{cmd}` survives unchanged (not materialised) while the
  intended field changes.
- **init preserves references:** edit one field, Enter past a `{cmd}` field →
  the `{cmd}` survives unchanged in the written file.
- **doctor:** `diskSource` derived from raw (independent of resolved config);
  `effectiveSource` reflects a shadow (Slack fixed-env; apiKey `cli-config`); a
  `{cmd}` shadowed by either is **not executed**; an unshadowed `{cmd}` failure
  → FAIL; `--json` carries `diskSource`/`effectiveSource` but no resolved value,
  stdout, or stderr.

## Deliverables

- `secret-source.ts` (+ tests); `config.ts` — `SecretSource` types,
  `RawGatewayConfig`, `loadRawGatewayConfig`, Slack-eager resolution in
  `loadGatewayConfig`, `saveGatewayConfig(raw)`; shared
  `resolveGatewayApiKey(cliConfig, rawGatewayApiKey)` helper used by both
  `slack/index.ts` and `doctor`; **migrate every gateway.json mutator** (admin /
  audience / escalation CLI + Slack `/pmk admin` + init) to raw load/edit/save;
  doctor extension (+ tests); init help text; deployment doc section.
- **ADR-0008** (`apps/docs/docs/adr/0008-gateway-secret-references.md`)
  recording the decision (references over plaintext; cmd+env, manager-agnostic;
  non-goals).

## Out of scope / future

- Phase 2: interactive reference wizard in `gateway init`.
- Native `op://` / `vault://` URI schemes (only if a real operator needs them).
- Secret caching / rotation.
