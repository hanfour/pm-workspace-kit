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

Resolution happens inside `loadGatewayConfig` (alongside the task-B
`normaliseRawConfig`). The **in-memory `GatewayConfig` keeps
`appToken?: string`** (the resolved value) — the union exists only in the
raw/stored representation, so no downstream consumer changes.

### Precedence (highest → lowest), with short-circuit

Preserves the current "env always wins" mental model:

```
fixed-name env override (PMK_SLACK_APP_TOKEN / PMK_SLACK_BOT_TOKEN / ANTHROPIC_API_KEY)
  ↳ else: resolved gateway.json reference ({cmd} or {env})
      ↳ else: literal value
```

Mechanically, the fixed-name override is checked **first and short-circuits**:

```ts
const value = fixedNameOverride ?? resolveSecret(raw.secret);
```

So when the override is set, the reference is **never evaluated** — a one-off
`PMK_SLACK_APP_TOKEN=...` still works even if the file's `{cmd}` would fail
(e.g. the manager is temporarily unreachable). The fail-fast on a broken
reference only fires when no override is present.

### Raw-shape validation (task-B lenient style)

`normaliseRawConfig` accepts the union and validates the reference shape:
`{ cmd }` / `{ env }` must have a string field, else the source is treated as
absent (→ no value) rather than crashing. A literal string passes as today.

## Error handling

- `{cmd}` failure (non-zero exit / timeout / empty) → fail-fast at load with
  a clear message naming **which secret** failed and the exit code — **never
  the command's stdout** (it may be the secret).
- Resolved secrets are never logged.
- A `{cmd}` that resolves but the secret is malformed (wrong prefix) surfaces
  through the existing `hasValidSlackTokens` path, unchanged.

## doctor

Extend the existing gateway.json checks:

- Keep the 0600 mode check.
- Report each secret's **source**: `literal` / `env:<NAME>` / `cmd` /
  `fixed-env(PMK_SLACK_*)`.
- Run each `{cmd}` reference once to confirm a non-empty value; failure →
  FAIL (exit 1), error excludes stdout.
- PASS line "no plaintext secrets on disk" when none of the three is a
  `literal`.

## Init UX (v1 scope)

- No change to the interactive value-entry flow (still paste literals).
- Add one help line to the token prompts: "or leave blank and inject via env
  (`PMK_SLACK_*` / `op run`), or hand-edit gateway.json to use a
  `{cmd}` / `{env}` reference."
- Interactive literal/env/cmd wizard → **deferred (phase 2)**; the schema +
  resolver + doctor already let an advanced operator go plaintext-free by
  hand-editing. Pure UX sugar, YAGNI for v1.

## Testing

- `resolveSecret`: literal; `{env}` set → value, unset → throws; `{cmd}`
  success / non-zero / empty / timeout (last three throw); **error excludes
  stdout** (no-leak assertion).
- `normaliseRawConfig`: accepts the union; malformed `{cmd}`/`{env}`
  (non-string field) → treated as absent, no crash.
- Precedence + short-circuit: fixed-name env override > reference > literal;
  a set override skips a would-be-failing reference (no throw).
- doctor: source reporting; `{cmd}` failure → FAIL; no-leak.

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
