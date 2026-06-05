# Gateway Secret References Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `~/.pmk/gateway.json` carry a secret *reference* (`{cmd}` or `{env}`) instead of plaintext for `slack.appToken`, `slack.botToken`, and `apiKey`, resolved before runtime use — manager-agnostic, zero per-manager code.

**Architecture:** A new `secret-source.ts` unit defines `SecretSource` + `resolveSecret`. `config.ts` splits into a *raw* on-disk shape (`RawGatewayConfig`, secret fields = `SecretSource`) and a *resolved* runtime `GatewayConfig` (Slack tokens eager-resolved to strings; `apiKey` stays raw, resolved lazily at the provider merge via a shared `resolveGatewayApiKey` helper). Every `gateway.json` mutator switches to `loadRawGatewayConfig`/`saveGatewayConfig(raw)` so an unrelated edit never materialises a referenced secret. `doctor` reports `diskSource`/`effectiveSource` and validates references without leaking stdout/stderr.

**Tech Stack:** TypeScript, Node `node:test` + `node:assert/strict`, `node:child_process.execSync`. Spec: `docs/superpowers/specs/2026-06-05-gateway-secret-references-design.md`.

**Run tests:** `cd packages/cli && npm test` (runs `typecheck:test` then the suite). Single file: `node --import tsx --test test/<file>.test.ts`.

---

## File Structure

- **Create** `packages/cli/src/gateway/secret-source.ts` — `SecretSource` type, `SecretResolutionError`, `validateSecretSource` (well-formedness, throws on malformed), `resolveSecret` (literal/env/cmd, no-leak), `secretDiskLabel`.
- **Create** `packages/cli/test/secret-source.test.ts`.
- **Modify** `packages/cli/src/gateway/config.ts` — `SlackConfig`/`GatewayConfig` types, add `RawSlackConfig`/`RawGatewayConfig`, `GatewayConfig.apiKey: SecretSource`; `normaliseRawConfig` → returns `RawGatewayConfig` + validates secrets; `loadRawGatewayConfig`; `loadGatewayConfig` (eager Slack resolve); `saveGatewayConfig(raw)`; `resolveGatewayApiKey` helper.
- **Modify** `packages/cli/test/gateway.test.ts` — config tests for the new behaviour.
- **Modify** `packages/cli/src/gateway/slack/index.ts:189-193` — provider merge uses `resolveGatewayApiKey`.
- **Modify** mutators to raw load/save: `packages/cli/src/commands/gateway/admin.ts`, `audience.ts`, `escalation.ts`, `packages/cli/src/gateway/slack/admin.ts`, `packages/cli/src/commands/gateway/ops.ts` (init).
- **Create** `packages/cli/src/gateway/doctor-checks/secret-sources.ts` + register in `doctor-checks/index.ts`; **Modify** `doctor.ts` (`DoctorContext.secretSources`).
- **Modify** `packages/cli/test/gateway-doctor.test.ts`.
- **Create** docs: deployment section + `apps/docs/docs/adr/0008-gateway-secret-references.md`.

---

## Task 1: `secret-source.ts` — types + `resolveSecret` + validation

**Files:**
- Create: `packages/cli/src/gateway/secret-source.ts`
- Test: `packages/cli/test/secret-source.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/secret-source.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveSecret,
  validateSecretSource,
  secretDiskLabel,
  SecretResolutionError,
} from "../src/gateway/secret-source";

describe("validateSecretSource", () => {
  it("passes a literal string through", () => {
    assert.equal(validateSecretSource("xapp-x", "slack.appToken"), "xapp-x");
  });
  it("accepts a well-formed {env} / {cmd}", () => {
    assert.deepEqual(validateSecretSource({ env: "X" }, "s"), { env: "X" });
    assert.deepEqual(validateSecretSource({ cmd: "op read x" }, "s"), { cmd: "op read x" });
  });
  it("undefined → undefined (absent, not an error)", () => {
    assert.equal(validateSecretSource(undefined, "s"), undefined);
  });
  it("throws on ambiguous {env,cmd}", () => {
    assert.throws(() => validateSecretSource({ env: "X", cmd: "y" }, "s"), SecretResolutionError);
  });
  it("throws on empty / unknown / non-string", () => {
    assert.throws(() => validateSecretSource({}, "s"), SecretResolutionError);
    assert.throws(() => validateSecretSource({ foo: "x" }, "s"), SecretResolutionError);
    assert.throws(() => validateSecretSource({ cmd: "" }, "s"), SecretResolutionError);
    assert.throws(() => validateSecretSource({ env: 42 }, "s"), SecretResolutionError);
    assert.throws(() => validateSecretSource(42, "s"), SecretResolutionError);
  });
});

describe("resolveSecret", () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.PMK_TEST_SECRET; });
  afterEach(() => {
    if (saved === undefined) delete process.env.PMK_TEST_SECRET;
    else process.env.PMK_TEST_SECRET = saved;
  });

  it("literal → itself; undefined → undefined", () => {
    assert.equal(resolveSecret("lit", "s"), "lit");
    assert.equal(resolveSecret(undefined, "s"), undefined);
  });
  it("{env} set → value; unset → throws; empty → throws", () => {
    process.env.PMK_TEST_SECRET = "v";
    assert.equal(resolveSecret({ env: "PMK_TEST_SECRET" }, "s"), "v");
    delete process.env.PMK_TEST_SECRET;
    assert.throws(() => resolveSecret({ env: "PMK_TEST_SECRET" }, "s"), SecretResolutionError);
    process.env.PMK_TEST_SECRET = "";
    assert.throws(() => resolveSecret({ env: "PMK_TEST_SECRET" }, "s"), SecretResolutionError);
  });
  it("{cmd} success → trimmed stdout", () => {
    assert.equal(resolveSecret({ cmd: "printf 'tok\\n'" }, "s"), "tok");
  });
  it("{cmd} non-zero / empty → throws", () => {
    assert.throws(() => resolveSecret({ cmd: "exit 3" }, "s"), SecretResolutionError);
    assert.throws(() => resolveSecret({ cmd: "true" }, "s"), SecretResolutionError);
  });
  it("error never leaks stdout OR stderr", () => {
    const cmd = "echo SECRET_ON_STDOUT; echo SECRET_ON_STDERR 1>&2; exit 1";
    try {
      resolveSecret({ cmd }, "slack.appToken");
      assert.fail("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      assert.doesNotMatch(msg, /SECRET_ON_STDOUT/);
      assert.doesNotMatch(msg, /SECRET_ON_STDERR/);
      assert.match(msg, /slack\.appToken/);
    }
  });
});

describe("secretDiskLabel", () => {
  it("labels each shape", () => {
    assert.equal(secretDiskLabel("x"), "literal");
    assert.equal(secretDiskLabel({ env: "MY" }), "env:MY");
    assert.equal(secretDiskLabel({ cmd: "op read x" }), "cmd");
    assert.equal(secretDiskLabel(undefined), "unset");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/secret-source.test.ts`
Expected: FAIL — cannot find module `../src/gateway/secret-source`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/cli/src/gateway/secret-source.ts
import { execSync } from "node:child_process";

/**
 * On-disk representation of a gateway secret. A bare string is a literal
 * (back-compat). An object is a *reference* resolved before runtime use.
 */
export type SecretSource = string | { env: string } | { cmd: string };

/** Thrown when a reference is malformed or can't produce a non-empty value. */
export class SecretResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretResolutionError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate + narrow an untrusted on-disk secret value. A string is a literal.
 * An object MUST have exactly one of `env` / `cmd` with a non-empty string
 * value — anything else throws (a reference typo must be loud, never silently
 * "absent"). `undefined` is genuinely absent and returns `undefined`.
 */
export function validateSecretSource(
  v: unknown,
  secretName: string,
): SecretSource | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string") return v;
  if (!isRecord(v)) {
    throw new SecretResolutionError(
      `gateway: ${secretName} must be a string or a {env}|{cmd} reference`,
    );
  }
  const keys = Object.keys(v);
  const hasEnv = "env" in v;
  const hasCmd = "cmd" in v;
  if (hasEnv === hasCmd || keys.length !== 1) {
    throw new SecretResolutionError(
      `gateway: ${secretName} reference must have exactly one of {env}|{cmd}`,
    );
  }
  const value = hasEnv ? v.env : v.cmd;
  if (typeof value !== "string" || value.length === 0) {
    throw new SecretResolutionError(
      `gateway: ${secretName} reference value must be a non-empty string`,
    );
  }
  return hasEnv ? { env: value } : { cmd: value };
}

/**
 * Resolve a well-formed source to a secret string. Assumes validation already
 * ran (see validateSecretSource). Throws `SecretResolutionError` when an
 * explicit reference yields nothing — the error NEVER includes the command's
 * stdout or stderr (either may carry the secret); only the secret name +
 * exit/signal.
 */
export function resolveSecret(
  src: SecretSource | undefined,
  secretName: string,
): string | undefined {
  if (src === undefined) return undefined;
  if (typeof src === "string") return src;
  if ("env" in src) {
    const v = process.env[src.env];
    if (v === undefined || v === "") {
      throw new SecretResolutionError(
        `gateway: ${secretName} env var ${src.env} is unset or empty`,
      );
    }
    return v;
  }
  let out: string;
  try {
    out = execSync(src.cmd, {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { status?: number; signal?: string };
    const detail = e.signal ? `signal ${e.signal}` : `exit ${e.status ?? "?"}`;
    throw new SecretResolutionError(
      `gateway: ${secretName} command failed (${detail})`,
    );
  }
  const trimmed = out.trimEnd();
  if (trimmed === "") {
    throw new SecretResolutionError(
      `gateway: ${secretName} command produced no output`,
    );
  }
  return trimmed;
}

/** Disk-shape label for doctor reporting — never reveals the value. */
export function secretDiskLabel(src: SecretSource | undefined): string {
  if (src === undefined) return "unset";
  if (typeof src === "string") return "literal";
  if ("env" in src) return `env:${src.env}`;
  return "cmd";
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd packages/cli && node --import tsx --test test/secret-source.test.ts`
Expected: PASS (all `secret-source` tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/secret-source.ts packages/cli/test/secret-source.test.ts
git commit -m "feat(gateway): SecretSource type + resolveSecret (cmd/env, no-leak)"
```

---

> **Subsequent tasks** (2–9) continue in this file. Each is written as its own
> failing-test → implement → pass → commit cycle. See the task list below; the
> per-step code is filled in section by section.

## Task 2: config.ts — raw types + `normaliseRawConfig` validates secrets

**Files:**
- Modify: `packages/cli/src/gateway/config.ts` (types ~20-107; `normaliseRawConfig` 192-255)
- Test: `packages/cli/test/gateway.test.ts` (describe `"gateway config"`)

- [ ] **Step 1: Write the failing test** (append inside the `describe("gateway config", ...)` block)

```ts
  it("normalises secret references and rejects malformed ones", async () => {
    const { normaliseRawConfigForTest } = await import("../src/gateway/config");
    const raw = normaliseRawConfigForTest({
      version: 1,
      admins: [],
      blocklist: [],
      audience: { default: "biz", users: {}, channels: {} },
      escalation: { default: [], repos: {} },
      slack: { appToken: { cmd: "op read x" }, botToken: "xoxb-lit" },
      apiKey: { env: "MY_KEY" },
    });
    assert.deepEqual(raw.slack.appToken, { cmd: "op read x" });
    assert.equal(raw.slack.botToken, "xoxb-lit");
    assert.deepEqual(raw.apiKey, { env: "MY_KEY" });

    assert.throws(
      () =>
        normaliseRawConfigForTest({
          version: 1,
          slack: { appToken: { env: "X", cmd: "y" } },
        }),
      /exactly one of/,
    );
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/gateway.test.ts`
Expected: FAIL — `normaliseRawConfigForTest` is not exported.

- [ ] **Step 3: Implement**

In `config.ts`, add to the import block at the top (after the `@pmk/shared` import):

```ts
import {
  type SecretSource,
  validateSecretSource,
  resolveSecret,
} from "./secret-source";
```

Replace the `SlackConfig` interface (lines 20-29) with the resolved + raw pair:

```ts
/** Resolved Slack config consumers see (tokens are plain strings). */
export interface SlackConfig {
  appToken?: string;
  botToken?: string;
  botUserId?: string;
  workspaceName?: string;
}

/** On-disk Slack config: tokens may be a literal or a {env}/{cmd} reference. */
export interface RawSlackConfig {
  appToken?: SecretSource;
  botToken?: SecretSource;
  botUserId?: string;
  workspaceName?: string;
}
```

Change `GatewayConfig.apiKey` (line 105) from `apiKey?: string;` to:

```ts
  /**
   * Anthropic API key — a literal or a {env}/{cmd} reference. Resolved
   * lazily at the provider merge (see resolveGatewayApiKey), NOT at load,
   * so a gateway {cmd} never runs when the CLI config already supplies a key.
   */
  apiKey?: SecretSource;
```

Add the raw config type immediately after the `GatewayConfig` interface (after line 107):

```ts
/** On-disk gateway config — secret fields are unresolved `SecretSource`. */
export interface RawGatewayConfig extends Omit<GatewayConfig, "slack"> {
  slack: RawSlackConfig;
}
```

In `normaliseRawConfig` (lines 192-255): change the return type to `RawGatewayConfig`, replace the `slack` block (238-243) and the `apiKey` field (253):

```ts
function normaliseRawConfig(raw: unknown): RawGatewayConfig {
  // ...unchanged through the escalation block...
  const sRaw = (
    r.slack && typeof r.slack === "object" ? r.slack : {}
  ) as Record<string, unknown>;
  const slack: RawSlackConfig = {
    appToken: validateSecretSource(sRaw.appToken, "slack.appToken"),
    botToken: validateSecretSource(sRaw.botToken, "slack.botToken"),
    botUserId: asString(sRaw.botUserId),
    workspaceName: asString(sRaw.workspaceName),
  };
  return {
    version: GATEWAY_CONFIG_VERSION,
    admins: asStringArray(r.admins),
    blocklist: asStringArray(r.blocklist),
    audience,
    escalation,
    slack,
    defaultIngest: asString(r.defaultIngest),
    mraWorkspace: asString(r.mraWorkspace),
    apiKey: validateSecretSource(r.apiKey, "apiKey"),
  };
}

/** Test seam — exercises normaliseRawConfig without touching disk. */
export function normaliseRawConfigForTest(raw: unknown): RawGatewayConfig {
  return normaliseRawConfig(raw);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/cli && node --import tsx --test test/gateway.test.ts`
Expected: PASS the new case. NOTE: `loadGatewayConfig`/`applyEnvOverrides`/`saveGatewayConfig` now type-mismatch (they expect resolved). That is fixed in Task 3 — run `npx tsc -p tsconfig.json --noEmit` and expect errors confined to those three; do not commit yet.

- [ ] **Step 5: Proceed to Task 3 before committing** (config.ts must typecheck as a unit).

## Task 3: config.ts — raw/resolved load boundary + `resolveGatewayApiKey`

**Files:**
- Modify: `packages/cli/src/gateway/config.ts` (`applyEnvOverrides` 257-268; `loadGatewayConfig` 270-284; `saveGatewayConfig`)
- Test: `packages/cli/test/gateway.test.ts`

- [ ] **Step 1: Write the failing tests** (append in `describe("gateway config", ...)`)

```ts
  it("loadGatewayConfig resolves Slack tokens; PMK_SLACK_* short-circuits the reference", () => {
    const file = path.join(tmpHome, ".pmk", "gateway.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        admins: [],
        blocklist: [],
        audience: { default: "biz", users: {}, channels: {} },
        escalation: { default: [], repos: {} },
        slack: { appToken: { cmd: "printf xapp-from-cmd" }, botToken: "xoxb-lit" },
      }),
    );
    // reference resolves
    let cfg = loadGatewayConfig();
    assert.equal(cfg.slack.appToken, "xapp-from-cmd");
    assert.equal(cfg.slack.botToken, "xoxb-lit");
    // fixed-name override wins WITHOUT running the {cmd}
    process.env.PMK_SLACK_APP_TOKEN = "xapp-override";
    cfg = loadGatewayConfig();
    assert.equal(cfg.slack.appToken, "xapp-override");
    delete process.env.PMK_SLACK_APP_TOKEN;
  });

  it("loadRawGatewayConfig keeps references unresolved (no cmd execution)", () => {
    const file = path.join(tmpHome, ".pmk", "gateway.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1, admins: [], blocklist: [],
        audience: { default: "biz", users: {}, channels: {} },
        escalation: { default: [], repos: {} },
        slack: { appToken: { cmd: "exit 1" } },
        apiKey: { env: "WHATEVER" },
      }),
    );
    const raw = loadRawGatewayConfig();
    assert.deepEqual(raw.slack.appToken, { cmd: "exit 1" }); // not executed
    assert.deepEqual(raw.apiKey, { env: "WHATEVER" });
  });

  it("saveGatewayConfig(loadRawGatewayConfig()) round-trips a reference (no materialise)", () => {
    const file = path.join(tmpHome, ".pmk", "gateway.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1, admins: [], blocklist: [],
        audience: { default: "biz", users: {}, channels: {} },
        escalation: { default: [], repos: {} },
        slack: { appToken: { cmd: "op read op://v/app" } },
      }),
    );
    saveGatewayConfig(loadRawGatewayConfig());
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(onDisk.slack.appToken, { cmd: "op read op://v/app" });
  });

  it("resolveGatewayApiKey: non-empty CLI key short-circuits the gateway {cmd}", async () => {
    const { resolveGatewayApiKey } = await import("../src/gateway/config");
    // CLI key present → used, gateway {cmd} (which would throw) NOT run
    assert.deepEqual(
      resolveGatewayApiKey("sk-cli", { cmd: "exit 1" }),
      { value: "sk-cli", usedCliConfig: true },
    );
    // empty CLI key treated as absent → reference resolves
    assert.deepEqual(
      resolveGatewayApiKey("", "sk-gw-literal"),
      { value: "sk-gw-literal", usedCliConfig: false },
    );
    // no CLI key, no gateway key → none
    assert.deepEqual(
      resolveGatewayApiKey(undefined, undefined),
      { value: undefined, usedCliConfig: false },
    );
  });
```

Add `loadRawGatewayConfig`, `saveGatewayConfig`, `resolveGatewayApiKey` to the existing `import { ... } from "../src/gateway/config"` line in the test file.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/gateway.test.ts`
Expected: FAIL — `loadRawGatewayConfig` / `resolveGatewayApiKey` not exported (and the save round-trip materialises).

- [ ] **Step 3: Implement** — replace `applyEnvOverrides` + `loadGatewayConfig` (lines 257-284) and `saveGatewayConfig`:

```ts
/** Resolve one Slack token: fixed-name env override wins (nullish), else the
 * on-disk reference. The override short-circuits BEFORE the reference runs. */
function resolveSlackToken(
  envName: string,
  src: SecretSource | undefined,
  secretName: string,
): string | undefined {
  const override = process.env[envName];
  return override ?? resolveSecret(src, secretName);
}

/** Read + normalise the on-disk config WITHOUT resolving any secret. */
export function loadRawGatewayConfig(): RawGatewayConfig {
  const file = gatewayConfigPath();
  if (!fs.existsSync(file)) {
    return {
      version: GATEWAY_CONFIG_VERSION,
      blocklist: [],
      admins: [],
      audience: defaultAudience(),
      escalation: defaultEscalation(),
      slack: {},
    };
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  return normaliseRawConfig(raw);
}

/** Runtime config consumers see: Slack tokens resolved eagerly (override
 * short-circuit + PMK_MRA_WORKSPACE); apiKey left raw for the provider merge. */
export function loadGatewayConfig(): GatewayConfig {
  const raw = loadRawGatewayConfig();
  return {
    ...raw,
    mraWorkspace: process.env.PMK_MRA_WORKSPACE ?? raw.mraWorkspace,
    slack: {
      appToken: resolveSlackToken(
        "PMK_SLACK_APP_TOKEN",
        raw.slack.appToken,
        "slack.appToken",
      ),
      botToken: resolveSlackToken(
        "PMK_SLACK_BOT_TOKEN",
        raw.slack.botToken,
        "slack.botToken",
      ),
      botUserId: raw.slack.botUserId,
      workspaceName: raw.slack.workspaceName,
    },
  };
}

/**
 * Resolve the effective Anthropic key. The CLI config key wins ONLY when it is
 * a non-empty string (matching the old truthy fallback); otherwise the gateway
 * reference resolves. Shared by slack/index.ts (value) and doctor (label +
 * whether to validate the reference), so the "does the {cmd} run?" decision
 * can't drift.
 */
export function resolveGatewayApiKey(
  cliApiKey: string | undefined,
  rawGatewayApiKey: SecretSource | undefined,
): { value: string | undefined; usedCliConfig: boolean } {
  if (typeof cliApiKey === "string" && cliApiKey !== "") {
    return { value: cliApiKey, usedCliConfig: true };
  }
  return { value: resolveSecret(rawGatewayApiKey, "apiKey"), usedCliConfig: false };
}
```

Change `saveGatewayConfig`'s parameter type from `cfg: GatewayConfig` to `cfg: RawGatewayConfig` (body unchanged — it already `JSON.stringify`s the passed object). Delete the now-unused `applyEnvOverrides` function.

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/cli && npm test`
Expected: the new cases PASS. Other call sites (`saveGatewayConfig(resolvedCfg)` in mutators, `this.config.apiKey` in slack/index.ts) now type-error — those are Tasks 4-6. Run `npx tsc -p tsconfig.json --noEmit` and confirm errors are ONLY in `slack/index.ts` + the mutator files; do not commit yet.

- [ ] **Step 5: Commit config core** (after Task 4 makes slack/index.ts compile)

```bash
git add packages/cli/src/gateway/config.ts packages/cli/test/gateway.test.ts
git commit -m "feat(gateway): raw/resolved config boundary + resolveGatewayApiKey"
```

## Task 4: slack/index.ts — provider merge uses `resolveGatewayApiKey`

**Files:**
- Modify: `packages/cli/src/gateway/slack/index.ts` (provider merge ~189-193; the `../config` import line ~26)

- [ ] **Step 1: Update the import** — add `resolveGatewayApiKey` to the existing `import { ... } from "../config";` in `slack/index.ts`.

- [ ] **Step 2: Replace the merge block** (the `const mergedConfig = baseCliConfig.apiKey ? ...` lines):

```ts
      const baseCliConfig = loadCliConfig();
      const { value: apiKey } = resolveGatewayApiKey(
        baseCliConfig.apiKey,
        this.config.apiKey,
      );
      const mergedConfig = { ...baseCliConfig, apiKey };
      this.llm = resolveProvider(mergedConfig);
```

- [ ] **Step 3: Typecheck**

Run: `cd packages/cli && npx tsc -p tsconfig.json --noEmit`
Expected: `slack/index.ts` clean; remaining errors only in the mutator files (Task 5).

- [ ] **Step 4: Commit (with Task 3)**

```bash
git add packages/cli/src/gateway/config.ts packages/cli/src/gateway/slack/index.ts packages/cli/test/gateway.test.ts
git commit -m "feat(gateway): resolve apiKey via shared helper at provider merge"
```

---

## Task 5: Migrate non-secret mutators to `loadRawGatewayConfig`

These only edit admins / audience / escalation (non-secret) fields, so the only
change is the load call (+ import). This stops an unrelated edit from
materialising a referenced secret on save.

**Files:**
- Modify: `packages/cli/src/commands/gateway/admin.ts` (line 26)
- Modify: `packages/cli/src/commands/gateway/audience.ts` (line 31)
- Modify: `packages/cli/src/commands/gateway/escalation.ts` (line 42)
- Modify: `packages/cli/src/gateway/slack/admin.ts` (lines 153, 181, 321)
- Test: `packages/cli/test/gateway.test.ts`

- [ ] **Step 1: Write the failing materialisation test** (in `describe("gateway config", ...)`)

```ts
  it("an unrelated audience edit preserves a {cmd} appToken (no materialise)", async () => {
    const { audienceSetForTest } = await import("../src/commands/gateway/audience");
    const file = path.join(tmpHome, ".pmk", "gateway.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1, admins: [], blocklist: [],
        audience: { default: "biz", users: {}, channels: {} },
        escalation: { default: [], repos: {} },
        slack: { appToken: { cmd: "op read op://v/app" }, botToken: "xoxb-x" },
      }),
    );
    audienceSetForTest("U-ALICE", "tech");
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(onDisk.slack.appToken, { cmd: "op read op://v/app" }); // intact
    assert.equal(onDisk.audience.users["U-ALICE"], "tech"); // edit landed
  });
```

If `audience.ts` has no test seam, add one near its exports:
```ts
/** Test seam: set a per-user audience override and persist. */
export function audienceSetForTest(userId: string, key: AudienceKey): void {
  const cfg = loadRawGatewayConfig();
  cfg.audience.users[userId] = key;
  saveGatewayConfig(cfg);
}
```
(Use the same `loadRawGatewayConfig`/`saveGatewayConfig` the real handler now uses.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/gateway.test.ts`
Expected: FAIL — appToken materialised to the plaintext string `xapp-...`, or the seam is missing.

- [ ] **Step 3: Implement** — in each file, change the import on the `config` line to include `loadRawGatewayConfig`, and replace every `const cfg = loadGatewayConfig();` that is followed by a `saveGatewayConfig(cfg)` with `const cfg = loadRawGatewayConfig();`. Exact sites:
  - `commands/gateway/admin.ts:26`
  - `commands/gateway/audience.ts:31`
  - `commands/gateway/escalation.ts:42`
  - `gateway/slack/admin.ts:153`, `:181`, `:321`

  Read-only handlers that `loadGatewayConfig()` but never save (e.g. a "list"
  subcommand) MAY stay on `loadGatewayConfig` — but switching them to raw is
  harmless since they only read non-secret fields; prefer raw for consistency.

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/cli && npm test`
Expected: PASS; `npx tsc -p tsconfig.json --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/gateway/admin.ts packages/cli/src/commands/gateway/audience.ts packages/cli/src/commands/gateway/escalation.ts packages/cli/src/gateway/slack/admin.ts packages/cli/test/gateway.test.ts
git commit -m "fix(gateway): all config mutators load/save raw — no secret materialisation"
```

## Task 6: `init` — raw load/save, preserve references on Enter

`init` is the one mutator that touches secret fields. It must load raw so a
plain Enter preserves an existing `{cmd}`/`{env}` reference, and only a freshly
typed literal replaces it. Format validation (xapp-/xoxb- prefix) applies ONLY
to freshly typed literals; preserved references defer to runtime/doctor.

**Files:**
- Modify: `packages/cli/src/commands/gateway/ops.ts` (`initCmd`: the `existing` load; token prompts 184-199; apiKey 255-262; cfg build 264-274; the `hasValidSlackTokens(cfg)` gate ~275)
- Test: `packages/cli/test/gateway.test.ts`

- [ ] **Step 1: Write the failing test** — extract the pure cfg-builder so it's testable without stdin. Add this seam to `ops.ts` and test it:

```ts
// in ops.ts — pure, no I/O. typed === user typed a new literal this run.
export function buildInitConfigForTest(args: {
  existing: RawGatewayConfig;
  appTokenTyped?: string; // undefined/"" = Enter (preserve)
  botTokenTyped?: string;
  apiKeyTyped?: string;
}): RawGatewayConfig {
  const appToken = args.appTokenTyped?.trim() || args.existing.slack.appToken;
  const botToken = args.botTokenTyped?.trim() || args.existing.slack.botToken;
  const apiKey = args.apiKeyTyped?.trim() || args.existing.apiKey;
  return {
    ...args.existing,
    apiKey,
    slack: { ...args.existing.slack, appToken, botToken },
  };
}
```

```ts
// test/gateway.test.ts (in describe("gateway config"))
  it("init preserves a {cmd} reference on Enter, replaces on a typed literal", async () => {
    const { buildInitConfigForTest } = await import("../src/commands/gateway/ops");
    const existing = {
      version: 1 as const, admins: [], blocklist: [],
      audience: { default: "biz" as const, users: {}, channels: {} },
      escalation: { default: [], repos: {} },
      slack: { appToken: { cmd: "op read op://v/app" }, botToken: "xoxb-old" },
    };
    // Enter on appToken (preserve), type a new botToken
    const out = buildInitConfigForTest({
      existing,
      appTokenTyped: "",
      botTokenTyped: "xoxb-new",
    });
    assert.deepEqual(out.slack.appToken, { cmd: "op read op://v/app" });
    assert.equal(out.slack.botToken, "xoxb-new");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/gateway.test.ts`
Expected: FAIL — `buildInitConfigForTest` not exported.

- [ ] **Step 3: Implement**
  1. Add `RawGatewayConfig`, `loadRawGatewayConfig` to the `ops.ts` import from `../../gateway/config`.
  2. Change the init `existing` load to `const existing = loadRawGatewayConfig();`.
  3. Add `buildInitConfigForTest` (above) near the other exports.
  4. In `initCmd`, build the saved object via the same logic and `saveGatewayConfig(cfg)` — `cfg` is now a `RawGatewayConfig`.
  5. Replace the `hasValidSlackTokens(cfg)` gate with: abort only if a token is **absent**; and if a token was **typed this run as a literal**, validate its prefix inline:

```ts
    function presentAndFormatOk(typed: string, value: SecretSource | undefined, prefix: string): boolean {
      if (value === undefined) return false;            // absent → abort
      if (typed && typeof value === "string") return value.startsWith(prefix); // new literal → check
      return true;                                       // preserved reference/literal → ok
    }
    const appOk = presentAndFormatOk(appTokenInput, appToken, "xapp-");
    const botOk = presentAndFormatOk(botTokenInput, botToken, "xoxb-");
    if (!appOk || !botOk) {
      println(chalk.red("tokens missing or wrong format (must start with xapp-/xoxb-). Aborting."));
      return;
    }
```
     (Capture the raw `.trim()` results as `appTokenInput` / `botTokenInput` before the `|| existing...` fallback so you know what was typed.)
  6. Add a help line under each token prompt:

```ts
    println(chalk.dim("    (blank = keep current; inject via PMK_SLACK_* / op run, or hand-edit gateway.json to use a {\"cmd\":\"...\"} / {\"env\":\"...\"} reference)"));
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/cli && npm test` ; `npx tsc -p tsconfig.json --noEmit`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/gateway/ops.ts packages/cli/test/gateway.test.ts
git commit -m "feat(gateway): init loads/saves raw — Enter preserves secret references"
```

## Task 7: doctor — secret-source check (diskSource / effectiveSource, no-leak)

**Files:**
- Modify: `packages/cli/src/gateway/doctor.ts` (`DoctorContext` 56-63; `buildDoctorContext` 136-184)
- Create: `packages/cli/src/gateway/doctor-checks/secret-sources.ts`
- Modify: `packages/cli/src/gateway/doctor-checks/index.ts` (add to `DEFAULT_CHECKS`)
- Test: `packages/cli/test/gateway-doctor.test.ts`

- [ ] **Step 1: Extend `DoctorContext`** — add two fields (import `SecretSource` from `./secret-source`):

```ts
  /** Raw on-disk secret sources (for source reporting — never resolved here). */
  secretSources: {
    appToken?: SecretSource;
    botToken?: SecretSource;
    apiKey?: SecretSource;
  };
  /** CLI-config apiKey (= ANTHROPIC_API_KEY ?? ~/.pmk/config.json), for apiKey shadowing. */
  cliApiKey?: string;
```

In `buildDoctorContext`, populate them from a raw load + CLI config. Use
`loadRawGatewayConfig()` in the production branch and, in the test branch
(direct `JSON.parse`), run the parsed object through `normaliseRawConfigForTest`
to get validated `SecretSource`s. Set `cliApiKey: loadConfig().apiKey`.

- [ ] **Step 2: Write the check + failing test**

```ts
// packages/cli/src/gateway/doctor-checks/secret-sources.ts
import type { DoctorCheck } from "../doctor";
import { secretDiskLabel, resolveSecret } from "../secret-source";
import { resolveGatewayApiKey } from "../config";

/** Reports disk vs effective source per secret; validates a reference only
 * when it is the effective source (mirrors runtime short-circuit); never leaks
 * stdout/stderr. PASS "no literal secret sources in gateway.json" when none is
 * a literal. */
export const secretSourcesCheck: DoctorCheck = async (ctx) => {
  const ss = ctx.secretSources;
  const lines: string[] = [];
  let ok = true;

  for (const [name, envName, src] of [
    ["slack.appToken", "PMK_SLACK_APP_TOKEN", ss.appToken],
    ["slack.botToken", "PMK_SLACK_BOT_TOKEN", ss.botToken],
  ] as const) {
    const disk = secretDiskLabel(src);
    const override = process.env[envName];
    const shadowed = override !== undefined && override !== "";
    lines.push(`${name}: disk=${disk} effective=${shadowed ? "fixed-env" : disk}`);
    if (!shadowed && src !== undefined && typeof src !== "string") {
      try {
        resolveSecret(src, name);
      } catch (e) {
        ok = false;
        lines.push(`  ${name}: ${(e as Error).message}`);
      }
    }
  }

  const diskApi = secretDiskLabel(ss.apiKey);
  try {
    const { usedCliConfig } = resolveGatewayApiKey(ctx.cliApiKey, ss.apiKey);
    lines.push(`apiKey: disk=${diskApi} effective=${usedCliConfig ? "cli-config" : diskApi}`);
  } catch (e) {
    ok = false;
    lines.push(`apiKey: ${(e as Error).message}`);
  }

  const noLiteral = [ss.appToken, ss.botToken, ss.apiKey].every(
    (s) => s === undefined || typeof s !== "string",
  );
  if (noLiteral) lines.push("no literal secret sources in gateway.json");

  return { name: "secret sources", ok, detail: lines.join("; ") };
};
```

Match the exact `DoctorCheck` / `DoctorCheckResult` shape used by sibling checks
(e.g. `doctor-checks/config-file.ts`) — adjust the returned object keys to match.

Test (follow the harness style in `gateway-doctor.test.ts` — build a context
with overrides):
```ts
  it("secret sources: a {cmd} shadowed by a fixed-env override is NOT executed", async () => {
    const { secretSourcesCheck } = await import("../src/gateway/doctor-checks/secret-sources");
    process.env.PMK_SLACK_APP_TOKEN = "xapp-override";
    const ctx = { secretSources: { appToken: { cmd: "exit 1" } }, cliApiKey: undefined } as any;
    const r = await secretSourcesCheck(ctx);
    assert.equal(r.ok, true); // would FAIL if it ran `exit 1`
    assert.match(r.detail, /effective=fixed-env/);
    delete process.env.PMK_SLACK_APP_TOKEN;
  });

  it("secret sources: an unshadowed failing {cmd} → FAIL, no leak", async () => {
    const { secretSourcesCheck } = await import("../src/gateway/doctor-checks/secret-sources");
    const ctx = { secretSources: { botToken: { cmd: "echo LEAK 1>&2; exit 1" } }, cliApiKey: undefined } as any;
    const r = await secretSourcesCheck(ctx);
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.detail, /LEAK/);
  });

  it("secret sources: CLI apiKey shadows gateway {cmd}", async () => {
    const { secretSourcesCheck } = await import("../src/gateway/doctor-checks/secret-sources");
    const ctx = { secretSources: { apiKey: { cmd: "exit 1" } }, cliApiKey: "sk-cli" } as any;
    const r = await secretSourcesCheck(ctx);
    assert.equal(r.ok, true);
    assert.match(r.detail, /apiKey:.*effective=cli-config/);
  });
```

- [ ] **Step 3: Register** — add `secretSourcesCheck` to `DEFAULT_CHECKS` in `doctor-checks/index.ts`.

- [ ] **Step 4: Run**

Run: `cd packages/cli && npm test` ; `npx tsc -p tsconfig.json --noEmit`
Expected: PASS + clean. Confirm `--json` output (in `doctor.ts`'s JSON path) carries the secret check's `detail` labels but no resolved value/stdout/stderr — the check never emits them, so this holds by construction.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/doctor.ts packages/cli/src/gateway/doctor-checks/secret-sources.ts packages/cli/src/gateway/doctor-checks/index.ts packages/cli/test/gateway-doctor.test.ts
git commit -m "feat(gateway): doctor secret-source check (disk/effective, no-leak)"
```

---

## Task 8: Docs + ADR-0008

**Files:**
- Create: `apps/docs/docs/adr/0008-gateway-secret-references.md`
- Modify: a gateway deployment/onboarding doc (e.g. `apps/docs/docs/gateway/` lifecycle or onboarding guide) — add a "Secrets without plaintext" section.

- [ ] **Step 1: ADR** — follow `apps/docs/docs/templates/adr-template.md` and the numbering/format of `apps/docs/docs/adr/0007-atom-approval-rubric.md`. Status: Accepted. Capture: decision (references over plaintext for gateway.json's three secrets; `{cmd}`+`{env}`, manager-agnostic); precedence (Slack fixed-env > reference > literal at load; apiKey via `resolveGatewayApiKey` at provider merge, CLI key short-circuits); non-goals (no native URI schemes, no caching/rotation, no init wizard); scope (no-plaintext claim is gateway.json-only — CLI-config apiKey out of scope).

- [ ] **Step 2: Deployment doc section** — show a `gateway.json` using `{cmd}`/`{env}`, the precedence, and `pmk gateway doctor` source reporting. Reference the spec.

- [ ] **Step 3: Commit**

```bash
git add apps/docs/docs/adr/0008-gateway-secret-references.md apps/docs/docs/gateway/
git commit -m "docs(adr): ADR-0008 gateway secret references + deployment guide"
```

- [ ] **Step 4: Final full check**

Run: `cd packages/cli && npm test` ; `npm run build`
Expected: all green; build OK. Then `npm audit` (no new advisories).
