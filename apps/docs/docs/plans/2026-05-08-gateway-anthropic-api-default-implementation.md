# Gateway `anthropic-api` as Default Provider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the gateway's default LLM provider from `claude-agent-sdk` to the direct Anthropic SDK so SDK-inherited host context is no longer a budget unknown, restore cap headroom, and add per-call `token.usage` telemetry.

**Architecture:** Soft-flip in `resolver.ts:autoResolve` (apiKey present → anthropic-api; else claude binary → claude-agent fallback). New `token.usage` event emitted by `AnthropicApiKeyProvider.chat()` after stream completion; `actor` threaded via a new optional `ChatOptions.actor` field. New `Token usage` section in `pmk gateway audit`. Cap defaults bumped: 25k → 60k session, 12k → 30k seed, 16k → 40k mra-result.

**Tech Stack:** TypeScript, `node:test` runner via `tsx`, `@anthropic-ai/sdk` (already a dependency).

**Source spec:** `apps/docs/docs/plans/2026-05-08-gateway-anthropic-api-default.md` (commit e5114b8).

---

## File map

| Path | Touched by |
|---|---|
| `packages/cli/src/llm/provider.ts` | T1, T4 |
| `packages/cli/src/gateway/events.ts` | T2 |
| `packages/cli/src/gateway/messaging.ts` | T3 |
| `packages/cli/src/llm/resolver.ts` | T4 |
| `packages/cli/src/llm/anthropic-api.ts` | T5 |
| `packages/cli/src/gateway/slack/index.ts` | T6 |
| `packages/cli/src/gateway/slack/context-retry.ts` | T6 |
| `packages/cli/src/gateway/audit.ts` | T7 |
| `packages/cli/src/gateway/audit-format.ts` | T8 |
| `packages/cli/src/commands/gateway.ts` | T9 |
| `packages/cli/src/llm/claude-agent.ts` | T10 |
| `packages/cli/test/messaging.test.ts` (extend) | T3 |
| `packages/cli/test/resolver.test.ts` (new) | T4 |
| `packages/cli/test/llm-anthropic-api.test.ts` (new) | T5 |
| `packages/cli/test/gateway-events.test.ts` (extend) | T2 |
| `packages/cli/test/gateway-audit.test.ts` (extend) | T7 |
| `packages/cli/test/gateway-audit-format.test.ts` (extend) | T8 |
| `apps/docs/docs/changelog.md` | T11 |
| `apps/docs/docs/gateway/v0.12-migration.md` (new) | T11 |

## Conventions

- TDD: write failing test → run (FAIL) → minimal impl → run (PASS) → commit.
- Single-file run: `cd packages/cli && node --import tsx --test test/<file>.test.ts`.
- Full suite: `npm --workspace packages/cli test`.
- Commit style: `<type>(<scope>): <description>`, no Co-Authored-By trailer.
- Each commit must leave the suite green.
- No version bump in individual tasks — T12 only.
- Branch: per `feedback_release_workflow.md` v0.x.0 = squash-merge feature PR. Suggested name `feat/gateway-anthropic-api-default`.

---

## Task 1: Add `actor?: string` to `ChatOptions`

**Files:** `packages/cli/src/llm/provider.ts`. No standalone test (interface-only; T5 exercises it).

- [ ] **Edit** `provider.ts`:

```ts
export interface ChatOptions {
  onToken?: (chunk: string) => void;
  /**
   * Slack user ID (or "cli:<name>" for CLI invocations) the call is on
   * behalf of. Used by AnthropicApiKeyProvider to attribute the
   * `token.usage` audit event. Optional — providers that don't emit
   * usage events ignore it; if undefined no event is written.
   */
  actor?: string;
}
```

- [ ] **Verify:** `cd packages/cli && npm run typecheck:test` — clean.
- [ ] **Commit:** `git commit -am "feat(llm): add optional actor field to ChatOptions for usage attribution"`

---

## Task 2: `TokenUsageEvent` in `events.ts`

**Files:** `packages/cli/src/gateway/events.ts`; extend `packages/cli/test/gateway-events.test.ts`.

- [ ] **Test** (append to gateway-events.test.ts inside the existing top-level describe):

```ts
it("round-trips token.usage event (T2 / v0.12.0)", () => {
  appendGatewayEvent({
    type: "token.usage",
    actor: "Uabc",
    provider: "anthropic-api",
    model: "claude-sonnet-4-6",
    inputTokens: 12345,
    outputTokens: 678,
    cacheReadTokens: 9000,
    cacheCreationTokens: 0,
  });
  const types = readGatewayEvents({}).map((e) => e.type);
  assert.ok(types.includes("token.usage"));
});
```

- [ ] **Impl** in `events.ts`. Add interface near other event interfaces:

```ts
export interface TokenUsageEvent {
  type: "token.usage";
  actor: string;
  provider: "anthropic-api" | "claude-agent";
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Present only when prompt caching was active. */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}
```

Extend `GatewayEvent` union to append `| TokenUsageEvent`.

Extend `VALID_TYPES`:

```ts
const VALID_TYPES: ReadonlySet<string> = new Set([
  "mra-ask.end", "turn.processed", "escalate.triggered", "escalate.absorbed",
  "gateway.online", "gateway.offline",
  "context.exceeded", "context.force-pruned", "message.capped",
  "token.usage",
]);
```

- [ ] **Commit:** `git commit -am "feat(gateway): add token.usage event type"`

---

## Task 3: Bump cap defaults in `messaging.ts`

**Files:** `packages/cli/src/gateway/messaging.ts`; extend `packages/cli/test/messaging.test.ts`.

- [ ] **Test** — flip the existing `describe("messaging cap defaults", …)` assertions to v0.12.0 values:

```ts
describe("messaging cap defaults (v0.12.0)", () => {
  it("MAX_SESSION_TOKENS default is 60_000", () => {
    assert.equal(MAX_SESSION_TOKENS, 60_000);
  });
  it("SEED_CAP default is 30_000", () => {
    assert.equal(SEED_CAP, 30_000);
  });
  it("MRA_RESULT_CAP default is 40_000", () => {
    assert.equal(MRA_RESULT_CAP, 40_000);
  });
});
```

- [ ] **Impl** in `messaging.ts` — change the three `parsePositiveIntEnv` defaults and rewrite each JSDoc:

```ts
/**
 * Soft cap for `session.approxTokens` before pruning kicks in.
 * v0.11.1 lowered to 25_000 to absorb claude-agent-sdk host-context
 * overhead. v0.12.0: raised back to 60_000 — anthropic-api is now the
 * default provider and SDK overhead is no longer in play. Tighten with
 * PMK_MAX_SESSION_TOKENS for hosts on the claude-agent fallback.
 */
export const MAX_SESSION_TOKENS = parsePositiveIntEnv(
  "PMK_MAX_SESSION_TOKENS",
  60_000,
);

/**
 * Maximum chars for the PKB seed message. v0.12.0: raised 12_000 →
 * 30_000 with anthropic-api default. Override with PMK_SEED_CAP=… per
 * host.
 */
export const SEED_CAP = parsePositiveIntEnv("PMK_SEED_CAP", 30_000);

/**
 * Maximum chars for `mra-ask` stdout pushed into session history.
 * v0.12.0: raised 16_000 → 40_000. Wired into capMessageContent at
 * the synthesiseAfterMra call site (slack/index.ts). Override with
 * PMK_MRA_RESULT_CAP=… per host.
 */
export const MRA_RESULT_CAP = parsePositiveIntEnv(
  "PMK_MRA_RESULT_CAP",
  40_000,
);
```

- [ ] **Verify** existing prune fixture (`gateway.test.ts:684` — 60 pairs × 4_000 chars ≈ 137k tokens) still exceeds the new 60k cap. Should — 137k > 60k. Run full suite to confirm.
- [ ] **Commit:** `git commit -am "feat(gateway): bump v0.12.0 cap defaults — MAX_SESSION_TOKENS 25k->60k, SEED_CAP 12k->30k, MRA_RESULT_CAP 16k->40k"`

---

## Task 4: Resolver `autoResolve` order swap

**Files:** `packages/cli/src/llm/resolver.ts`, `packages/cli/src/llm/provider.ts`; create `packages/cli/test/resolver.test.ts`.

- [ ] **Test** (new file `packages/cli/test/resolver.test.ts`):

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { resolveProvider } from "../src/llm/resolver";
import type { PmkConfig } from "@pmk/shared";

const ORIG_PMK = process.env.PMK_PROVIDER;
const ORIG_SKIP = process.env.PMK_SKIP_CLAUDE_PROBE;

function baseConfig(overrides: Partial<PmkConfig> = {}): PmkConfig {
  return {
    provider: "auto",
    model: "claude-sonnet-4-6",
    maxTokens: 4096,
    ...overrides,
  } as PmkConfig;
}

describe("resolveProvider autoResolve order (v0.12.0)", () => {
  beforeEach(() => {
    delete process.env.PMK_PROVIDER;
    process.env.PMK_SKIP_CLAUDE_PROBE = "1";
  });
  afterEach(() => {
    if (ORIG_PMK !== undefined) process.env.PMK_PROVIDER = ORIG_PMK;
    else delete process.env.PMK_PROVIDER;
    if (ORIG_SKIP !== undefined) process.env.PMK_SKIP_CLAUDE_PROBE = ORIG_SKIP;
    else delete process.env.PMK_SKIP_CLAUDE_PROBE;
  });

  it("apiKey present → anthropic-api (preferred over claude-agent)", () => {
    const provider = resolveProvider(baseConfig({ apiKey: "sk-ant-xxx" }));
    assert.equal(provider.name, "anthropic-api");
  });

  it("apiKey absent + no claude binary → throws NoProviderAvailableError", () => {
    assert.throws(
      () => resolveProvider(baseConfig({ apiKey: undefined })),
      /no usable LLM provider/,
    );
  });
});
```

- [ ] **Impl** in `resolver.ts` — replace `autoResolve` body:

```ts
function autoResolve(config: PmkConfig): LlmProvider {
  // v0.12.0: prefer anthropic-api when apiKey is available — eliminates
  // claude-agent-sdk host-context overhead. Falls through to claude-agent
  // for users without an API key (zero-touch upgrade for that branch).
  if (config.apiKey) {
    return new AnthropicApiKeyProvider({ ...config, apiKey: config.apiKey });
  }
  const claudePath = findClaudeExecutable();
  if (claudePath) {
    return new ClaudeAgentSdkProvider(config, claudePath);
  }
  throw new NoProviderAvailableError(["anthropic-api", "claude-agent"]);
}
```

Update `resolveProvider` JSDoc (lines 13-16) to reflect new order:

```ts
/**
 * Find a usable LLM provider.
 *
 * Order (`config.provider: "auto"`, v0.12.0+):
 *   1. ANTHROPIC_API_KEY (or config.apiKey) → AnthropicApiKeyProvider
 *   2. local `claude` binary on PATH → ClaudeAgentSdkProvider (fallback)
 *   3. fail with actionable error
 *
 * `PMK_PROVIDER` env var overrides `config.provider`.
 */
```

In `provider.ts` `NoProviderAvailableError`, lead with the API key path:

```ts
super(
  `[pmk] no usable LLM provider found (tried: ${attempted.join(", ")}).\n` +
    "  Try one of:\n" +
    "    • set ANTHROPIC_API_KEY in your environment — https://console.anthropic.com\n" +
    "    • install Claude Code and run `claude login` — https://claude.com/product/claude-code (legacy fallback)\n" +
    "  Or pin a provider with PMK_PROVIDER=<anthropic-api|claude-agent>.",
);
```

- [ ] **Commit:** `git add packages/cli/src/llm/resolver.ts packages/cli/src/llm/provider.ts packages/cli/test/resolver.test.ts && git commit -m "feat(llm): swap autoResolve to prefer anthropic-api over claude-agent"`

---

## Task 5: `AnthropicApiKeyProvider` emits `token.usage` event

**Files:** `packages/cli/src/llm/anthropic-api.ts`; create `packages/cli/test/llm-anthropic-api.test.ts`.

The Anthropic SDK exposes per-message usage via `message_start.message.usage` (input + cache fields known at start) and `message_delta.usage` (output_tokens, updated as the stream progresses). After the stream completes, both are merged for the final tally. Use `stream.finalMessage()` for clarity.

- [ ] **Test** (new file `packages/cli/test/llm-anthropic-api.test.ts`):

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ORIG_HOME = process.env.HOME;

describe("AnthropicApiKeyProvider token.usage emission (T5 / v0.12.0)", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-anthropic-test-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
    else delete process.env.HOME;
  });

  it("emits token.usage event after stream completes (when actor is provided)", async () => {
    const { AnthropicApiKeyProvider } = await import(
      "../src/llm/anthropic-api"
    );
    const { readGatewayEvents } = await import("../src/gateway/events");

    // Stub the underlying SDK by overriding the private `client` after
    // construction. The provider's chat() awaits client.messages.stream()
    // and iterates events; we need an async iterable that yields a
    // text_delta then exposes finalMessage() with usage fields.
    const provider = new AnthropicApiKeyProvider({
      provider: "anthropic-api",
      model: "claude-sonnet-4-6",
      maxTokens: 4096,
      apiKey: "sk-ant-test",
    } as never);

    const fakeStream = {
      [Symbol.asyncIterator]: async function* () {
        yield {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "hello" },
        };
      },
      finalMessage: async () => ({
        usage: {
          input_tokens: 1234,
          output_tokens: 56,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 0,
        },
      }),
    };
    (provider as unknown as { client: unknown }).client = {
      messages: { stream: async () => fakeStream },
    };

    const result = await provider.chat("sys", [{ role: "user", content: "hi" }], { actor: "Uabc" });
    assert.equal(result, "hello");

    const events = readGatewayEvents({});
    const usage = events.find((e) => e.type === "token.usage");
    assert.ok(usage, "expected token.usage event");
    if (usage && usage.type === "token.usage") {
      assert.equal(usage.actor, "Uabc");
      assert.equal(usage.provider, "anthropic-api");
      assert.equal(usage.model, "claude-sonnet-4-6");
      assert.equal(usage.inputTokens, 1234);
      assert.equal(usage.outputTokens, 56);
      assert.equal(usage.cacheReadTokens, 100);
      assert.equal(usage.cacheCreationTokens, 0);
    }
  });

  it("does NOT emit token.usage when actor is undefined", async () => {
    const { AnthropicApiKeyProvider } = await import(
      "../src/llm/anthropic-api"
    );
    const { readGatewayEvents } = await import("../src/gateway/events");

    const provider = new AnthropicApiKeyProvider({
      provider: "anthropic-api",
      model: "claude-sonnet-4-6",
      maxTokens: 4096,
      apiKey: "sk-ant-test",
    } as never);

    const fakeStream = {
      [Symbol.asyncIterator]: async function* () {
        yield {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "ok" },
        };
      },
      finalMessage: async () => ({
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    };
    (provider as unknown as { client: unknown }).client = {
      messages: { stream: async () => fakeStream },
    };

    await provider.chat("sys", [{ role: "user", content: "hi" }]);

    const events = readGatewayEvents({});
    assert.equal(
      events.filter((e) => e.type === "token.usage").length,
      0,
      "no token.usage event when actor missing",
    );
  });
});
```

- [ ] **Impl** in `anthropic-api.ts` — extend `chat()` to emit the event after stream completion:

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, PmkConfig } from "@pmk/shared";
import type { ChatOptions, LlmProvider } from "./provider";
import { appendGatewayEvent } from "../gateway/events";

export class AnthropicApiKeyProvider implements LlmProvider {
  readonly name = "anthropic-api" as const;
  readonly displayName = "Anthropic API (api key)";
  private readonly client: Anthropic;
  private readonly config: PmkConfig;

  constructor(config: PmkConfig & { apiKey: string }) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.config = config;
  }

  async chat(
    systemPrompt: string,
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): Promise<string> {
    const stream = await this.client.messages.stream({
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      system: systemPrompt,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    let full = "";
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        const chunk = event.delta.text;
        full += chunk;
        opts.onToken?.(chunk);
      }
    }

    // v0.12.0: emit token.usage audit event for the call. Only fires
    // when caller provided an actor (Slack user ID or "cli:<name>").
    // Best-effort — failures here must not break the chat() return.
    if (opts.actor) {
      try {
        const final = await stream.finalMessage();
        const usage = final.usage;
        appendGatewayEvent({
          type: "token.usage",
          actor: opts.actor,
          provider: "anthropic-api",
          model: this.config.model,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          ...(usage.cache_read_input_tokens !== undefined && usage.cache_read_input_tokens !== null
            ? { cacheReadTokens: usage.cache_read_input_tokens }
            : {}),
          ...(usage.cache_creation_input_tokens !== undefined && usage.cache_creation_input_tokens !== null
            ? { cacheCreationTokens: usage.cache_creation_input_tokens }
            : {}),
        });
      } catch {
        // Swallow — audit-event failures shouldn't surface as chat errors.
      }
    }

    return full;
  }
}
```

- [ ] **Commit:** `git add packages/cli/src/llm/anthropic-api.ts packages/cli/test/llm-anthropic-api.test.ts && git commit -m "feat(llm): AnthropicApiKeyProvider emits token.usage audit event when actor provided"`

---

## Task 6: Wire `actor: userId` into both LLM call sites in `slack/index.ts`

**Files:** `packages/cli/src/gateway/slack/index.ts`, `packages/cli/src/gateway/slack/context-retry.ts`. No new tests (existing context-retry tests don't assert on actor pass-through; T5 covers the emission side).

The `chatWithContextRetry` helper today builds `opts: ChatOptions = chatOptions ?? { onToken: () => {} }` internally. T6 needs `actor` to flow from the runFreeChatTurn / synthesiseAfterMra call sites all the way through to `llm.chat(opts)`.

- [ ] **Edit** `packages/cli/src/gateway/slack/context-retry.ts` — extend the inner opts construction to pass actor through:

Locate the line `const opts: ChatOptions = chatOptions ?? { onToken: () => {} };` (around line 79). Change to:

```ts
const opts: ChatOptions = {
  ...(chatOptions ?? { onToken: () => {} }),
  actor,
};
```

(`actor` is already destructured from `args` in this function — verify around line 75. The merge ensures `actor` is always present in the opts object passed to `llm.chat()`, regardless of what the caller supplied via `chatOptions`.)

- [ ] **Edit** `packages/cli/src/gateway/slack/index.ts` — verify both `chatWithContextRetry` call sites pass `actor: userId` (first-call) and `actor: actor` (synthesise round). Both already do via the existing `actor` field in `ContextRetryArgs`.

That means slack/index.ts requires **no edit for T6** — context-retry.ts forwards `actor` automatically once the opts merge is in place.

- [ ] **Verify:** `cd packages/cli && npm test` — 305+/305+ pass (T5 added 2 tests; this task adds 0).
- [ ] **Commit:** `git commit -am "feat(gateway): forward actor through chatWithContextRetry to llm.chat opts"`

---

## Task 7: Audit `tokenUsage` aggregation in `audit.ts`

**Files:** `packages/cli/src/gateway/audit.ts`; extend `packages/cli/test/gateway-audit.test.ts`.

- [ ] **Test** (extend gateway-audit.test.ts):

```ts
it("tokenUsage aggregates token.usage events (T7 / v0.12.0)", () => {
  const now = Date.now();
  appendGatewayEvent({ type: "token.usage", actor: "Uabc", provider: "anthropic-api", model: "claude-sonnet-4-6", inputTokens: 1000, outputTokens: 100 });
  appendGatewayEvent({ type: "token.usage", actor: "Uabc", provider: "anthropic-api", model: "claude-sonnet-4-6", inputTokens: 2000, outputTokens: 200, cacheReadTokens: 500 });
  appendGatewayEvent({ type: "token.usage", actor: "Udef", provider: "anthropic-api", model: "claude-sonnet-4-6", inputTokens: 3000, outputTokens: 300 });

  const report = buildAuditReport({ days: 30, nowMs: now });
  assert.equal(report.tokenUsage.total.inputTokens, 6000);
  assert.equal(report.tokenUsage.total.outputTokens, 600);
  assert.equal(report.tokenUsage.total.cacheReadTokens, 500);
  assert.equal(report.tokenUsage.total.cacheCreationTokens, 0);

  const top = report.tokenUsage.perActor;
  assert.equal(top[0].actor, "Udef");
  assert.equal(top[0].inputTokens, 3000);
  assert.equal(top[1].actor, "Uabc");
  assert.equal(top[1].inputTokens, 3000);

  assert.equal(report.tokenUsage.perModel.length, 1);
  assert.equal(report.tokenUsage.perModel[0].model, "claude-sonnet-4-6");
  assert.equal(report.tokenUsage.perModel[0].inputTokens, 6000);
});
```

- [ ] **Impl** in `audit.ts`. Extend `AuditReport` interface (after `contextSafety`, before `flags`):

```ts
tokenUsage: {
  total: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  /** Top actors by inputTokens, descending. */
  perActor: Array<{ actor: string; inputTokens: number; outputTokens: number }>;
  /** Per-model breakdown. */
  perModel: Array<{ model: string; inputTokens: number; outputTokens: number }>;
};
```

In `buildAuditReport`, add per-actor and per-model accumulators before the for-loop:

```ts
let tuTotalIn = 0, tuTotalOut = 0, tuCacheRead = 0, tuCacheCreate = 0;
const tuPerActor = new Map<string, { in: number; out: number }>();
const tuPerModel = new Map<string, { in: number; out: number }>();
```

Add a switch case:

```ts
case "token.usage": {
  tuTotalIn += e.inputTokens;
  tuTotalOut += e.outputTokens;
  tuCacheRead += e.cacheReadTokens ?? 0;
  tuCacheCreate += e.cacheCreationTokens ?? 0;
  const actorAcc = tuPerActor.get(e.actor) ?? { in: 0, out: 0 };
  actorAcc.in += e.inputTokens;
  actorAcc.out += e.outputTokens;
  tuPerActor.set(e.actor, actorAcc);
  const modelAcc = tuPerModel.get(e.model) ?? { in: 0, out: 0 };
  modelAcc.in += e.inputTokens;
  modelAcc.out += e.outputTokens;
  tuPerModel.set(e.model, modelAcc);
  break;
}
```

In the returned object, add `tokenUsage` (place between `contextSafety` and `flags`):

```ts
tokenUsage: {
  total: {
    inputTokens: tuTotalIn,
    outputTokens: tuTotalOut,
    cacheReadTokens: tuCacheRead,
    cacheCreationTokens: tuCacheCreate,
  },
  perActor: Array.from(tuPerActor.entries())
    .map(([actor, v]) => ({ actor, inputTokens: v.in, outputTokens: v.out }))
    .sort((a, b) => b.inputTokens - a.inputTokens),
  perModel: Array.from(tuPerModel.entries())
    .map(([model, v]) => ({ model, inputTokens: v.in, outputTokens: v.out }))
    .sort((a, b) => b.inputTokens - a.inputTokens),
},
```

- [ ] **`emptyReport` helper update:** `gateway-audit-format.test.ts`'s `emptyReport()` will fail typecheck once the new field is required. Add zero-value defaults in that helper:

```ts
tokenUsage: {
  total: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  perActor: [],
  perModel: [],
},
```

- [ ] **Commit:** `git commit -am "feat(gateway): aggregate token.usage events into AuditReport.tokenUsage"`

---

## Task 8: Audit `Token usage` section in `audit-format.ts`

**Files:** `packages/cli/src/gateway/audit-format.ts`; extend `packages/cli/test/gateway-audit-format.test.ts`.

- [ ] **Test:**

```ts
it("renders Token usage section with non-zero counts (T8 / v0.12.0)", () => {
  const report = emptyReport();
  report.tokenUsage = {
    total: { inputTokens: 12300, outputTokens: 700, cacheReadTokens: 9000, cacheCreationTokens: 0 },
    perActor: [
      { actor: "Uabc", inputTokens: 8200, outputTokens: 500 },
      { actor: "Udef", inputTokens: 3100, outputTokens: 150 },
      { actor: "Uxyz", inputTokens: 1000, outputTokens: 50 },
    ],
    perModel: [{ model: "claude-sonnet-4-6", inputTokens: 12300, outputTokens: 700 }],
  };
  const out = stripAnsi(formatAuditReport(report));
  assert.match(out, /Token usage/);
  assert.match(out, /total in \/ out:\s+12\.3k \/ 0\.7k tokens/);
  assert.match(out, /cache read:\s+9\.0k tokens/);
  assert.match(out, /per-actor.*Uabc 8\.2k in.*Udef 3\.1k in/);
  assert.match(out, /per-model:\s+claude-sonnet-4-6 \(12\.3k in \/ 0\.7k out\)/);
});

it("renders Token usage section with zero counts (always shown, no cache line)", () => {
  const report = emptyReport();
  const out = stripAnsi(formatAuditReport(report));
  assert.match(out, /Token usage/);
  assert.match(out, /total in \/ out:\s+0 \/ 0 tokens/);
  assert.doesNotMatch(out, /cache read:/);
  assert.match(out, /per-actor.*\(none\)/);
});
```

- [ ] **Impl** in `audit-format.ts`. Insert the section after the `// context safety` block, before the optional `// flags` block (around line 110):

```ts
// token usage
lines.push("");
lines.push(chalk.bold("Token usage"));
const tu = report.tokenUsage;
lines.push(label("total in / out:") + `${formatTokens(tu.total.inputTokens)} / ${formatTokens(tu.total.outputTokens)} tokens`);
if (tu.total.cacheReadTokens > 0) {
  lines.push(label("cache read:") + `${formatTokens(tu.total.cacheReadTokens)} tokens`);
}
lines.push(
  label("per-actor (top 3):") +
    (tu.perActor.length === 0
      ? chalk.dim("(none)")
      : tu.perActor
          .slice(0, 3)
          .map((e) => `${e.actor} ${formatTokens(e.inputTokens)} in`)
          .join(", ")),
);
lines.push(
  label("per-model:") +
    (tu.perModel.length === 0
      ? chalk.dim("(none)")
      : tu.perModel
          .map((e) => `${e.model} (${formatTokens(e.inputTokens)} in / ${formatTokens(e.outputTokens)} out)`)
          .join(", ")),
);
```

Add `formatTokens` helper at the bottom of the file (next to `formatDurationMs`):

```ts
/**
 * Render a token count in compact form. Below 1000 → bare integer.
 * 1k–999k → "X.Yk" (one decimal). >= 1M → "X.YM".
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
```

- [ ] **Commit:** `git commit -am "feat(gateway): render Token usage section in pmk gateway audit"`

---

## Task 9: `gateway init` API-key prompt

**Files:** `packages/cli/src/commands/gateway.ts`. Manual verify only (interactive prompt; T12 step 1 covers).

- [ ] **Edit** `gateway.ts`'s `initCmd` (line 104+). After the existing Slack token prompts (App-Level Token, then Bot User OAuth Token), add a v0.12 explanation banner and an API-key prompt before `saveGatewayConfig`.

Locate the section that currently saves the config after both Slack tokens. Just before `saveGatewayConfig({...})`, insert:

```ts
println("");
println(
  chalk.dim(
    "  v0.12+: pmk gateway prefers the Anthropic API directly (no SDK overhead).",
  ),
);
println(
  chalk.dim(
    "    If you skip this prompt, set ANTHROPIC_API_KEY in your environment, or",
  ),
);
println(
  chalk.dim(
    "    keep the legacy claude-agent path with PMK_PROVIDER=claude-agent.",
  ),
);
const apiKeyInput = (
  await rl.question(
    chalk.cyan(
      `Anthropic API key (sk-ant-...) ${existing.apiKey ? "[unchanged on enter]" : "[blank to use env var]"}: `,
    ),
  )
).trim();
const apiKey = apiKeyInput || existing.apiKey;
```

Then in the `saveGatewayConfig({...})` call, add `apiKey` to the persisted object:

```ts
saveGatewayConfig({
  ...existing,
  slack: { appToken, botToken },
  ...(apiKey ? { apiKey } : {}),
});
```

(The conditional spread avoids writing `apiKey: undefined` when both `existing.apiKey` and the new input are empty — keeps the file slim for users who never opt in.)

Verify `loadGatewayConfig()` already returns `apiKey?: string` on its result type. If not, add it to the type definition in `packages/cli/src/gateway/config.ts`.

- [ ] **Verify** typecheck clean: `cd packages/cli && npm run typecheck:test`.
- [ ] **Verify** existing init tests (in `gateway.test.ts` if any cover initCmd) still pass — the prompt is additive, no behavioural break for existing config files.
- [ ] **Commit:** `git commit -am "feat(gateway): init prompts for ANTHROPIC_API_KEY (v0.12 default-provider switch)"`

---

## Task 10: Comment in `claude-agent.ts` about fallback role

**Files:** `packages/cli/src/llm/claude-agent.ts`. No tests — comment-only change.

- [ ] **Edit** `claude-agent.ts` — replace the existing top-of-file JSDoc (lines 5-15) with:

```ts
/**
 * Delegates to the local `claude` CLI via the Claude Agent SDK, so we
 * inherit whatever auth the user already has (OAuth, subscription, API
 * key, Bedrock, Vertex) without requiring a separate ANTHROPIC_API_KEY.
 *
 * As of v0.12.0 this provider is the FALLBACK path — `autoResolve`
 * prefers `AnthropicApiKeyProvider` when an API key is available
 * because that path does not inherit the host's `~/.claude/` config
 * (skills/hooks/MCP descriptions) into every system prompt, which
 * v0.11.x had to absorb via tighter PMK_*_CAP defaults. This provider
 * still works without code changes; it just no longer defaults.
 *
 * The SDK is stateful per `query()` call. To keep `LlmProvider.chat`
 * stateless from the caller's perspective, each turn serialises the full
 * history into a single prompt wrapped with transcript markers. This is
 * slightly wasteful but keeps the caller interface identical to
 * `AnthropicApiKeyProvider`.
 */
```

- [ ] **Verify:** `cd packages/cli && npm test` — 305+/305+ pass (no behavioural change).
- [ ] **Commit:** `git commit -am "docs(llm): note v0.12 fallback role in claude-agent provider header"`

---

## Task 11: Changelog + v0.12 migration doc

**Files:** `apps/docs/docs/changelog.md`; create `apps/docs/docs/gateway/v0.12-migration.md`.

- [ ] **Edit** `apps/docs/docs/changelog.md` — insert a new `## [v0.12.0]` heading above the existing `## [v0.11.1]` block. Body:

```md
## [v0.12.0] — 2026-05-DD — gateway: anthropic-api as default provider

### Why

v0.11.1 hardened the gateway against `msg_too_long` by lowering caps and adding an auto-retry path, but cause #2 from the 2026-05-07 incident — `claude-agent-sdk` spawning the local `claude` CLI and inheriting the host's `~/.claude/` config (skills/hooks/MCP descriptions) as un-budgeted system context — was absorbed by tighter caps, not eliminated. v0.12.0 flips the default to the direct Anthropic SDK so SDK overhead is no longer a budget unknown, and restores cap headroom.

Spec: [`apps/docs/docs/plans/2026-05-08-gateway-anthropic-api-default.md`](./plans/2026-05-08-gateway-anthropic-api-default.md). Migration: [v0.12 migration notes](./gateway/v0.12-migration.md).

### Changed

- **Default LLM provider auto-resolves to `anthropic-api` first** (was `claude-agent`). Soft flip — users with `ANTHROPIC_API_KEY` set auto-switch; users without it stay on `claude-agent` with no behavioural change. `PMK_PROVIDER=claude-agent` still pins the legacy path explicitly.
- **Cap defaults restored to operationally useful values** now that SDK overhead is gone on the default path:
  - `PMK_MAX_SESSION_TOKENS` 25_000 → 60_000
  - `PMK_SEED_CAP` 12_000 → 30_000
  - `PMK_MRA_RESULT_CAP` 16_000 → 40_000
- **`gateway init` prompts for `ANTHROPIC_API_KEY`** after Slack tokens; stored in `~/.pmk/gateway.json` `apiKey` field at mode 0600. Empty input keeps existing value or falls back to env var.

### Added

- **`token.usage` event** in `events-YYYY-MM.log` — emitted by `AnthropicApiKeyProvider.chat()` after each successful stream completion, when an `actor` is provided in `ChatOptions`. Fields: `actor`, `provider`, `model`, `inputTokens`, `outputTokens`, optional `cacheReadTokens` / `cacheCreationTokens`. Best-effort write — failures don't break the chat.
- **`Token usage` section** in `pmk gateway audit` rolls up the new events: total in/out, cache read (when non-zero), top-3 per-actor by input tokens, per-model breakdown.
- **`ChatOptions.actor`** optional field on the `LlmProvider.chat()` interface for usage attribution. Other CLI commands not yet plumbed in this release — future work.

### Tests

`@pmk/cli` 304 → **313** (+9): `resolver.ts` autoResolve order (apiKey-preferred, fallback, both-missing), `AnthropicApiKeyProvider.chat()` token-usage emission with mocked stream + `finalMessage()`, no-emission when actor undefined, `events.ts` round-trip for `token.usage`, `audit.ts` aggregation, `audit-format.ts` `Token usage` rendering for non-zero + zero cases.

### Forward-looking

`claude-agent` provider stays as a soft-flip fallback indefinitely. Re-evaluate deprecation in v0.13+ based on usage data from the new `Token usage` audit section. $-cost calculation is a v0.13+ candidate, gated on a stable price-table source.

---

```

(The trailing `---` separates from the v0.11.1 block below.)

- [ ] **Create** `apps/docs/docs/gateway/v0.12-migration.md`:

```md
---
sidebar_position: 3
---

# v0.12 migration notes

Operator-facing summary of what changes when you upgrade `pmk gateway` from v0.11.x to v0.12.0.

## TL;DR

```
✅ Zero config changes required if you already have ANTHROPIC_API_KEY set.
✅ Existing ~/.pmk/gateway.json is back-fill-compatible (apiKey field
   is optional and additive).
✅ Users without an API key keep running on the claude-agent fallback —
   no behavioural change.
✅ Cap defaults bumped 25k/12k/16k → 60k/30k/40k. PMK_*_CAP still
   overrides per host.
```

## What changed

### Provider auto-resolution

Before (v0.11.x):

```
1. local `claude` binary → ClaudeAgentSdkProvider
2. ANTHROPIC_API_KEY → AnthropicApiKeyProvider
3. fail
```

After (v0.12.0):

```
1. ANTHROPIC_API_KEY (or config.apiKey) → AnthropicApiKeyProvider
2. local `claude` binary → ClaudeAgentSdkProvider (fallback)
3. fail
```

Why: `ClaudeAgentSdkProvider` spawns the local `claude` CLI and inherits the host's `~/.claude/` config (skills/hooks/MCP descriptions) as un-budgeted system context. On a heavy host this can add 10s of thousands of tokens to every API call. `AnthropicApiKeyProvider` calls the API directly with a clean system prompt — no overhead, predictable budgets.

### `gateway init` prompts for the API key

After the Slack token prompts, init now asks for `ANTHROPIC_API_KEY`. The value is stored in `~/.pmk/gateway.json` at mode 0600 alongside Slack tokens. Skip with empty input to fall back to the env var.

### New `token.usage` event in events log

JSONL line (synthetic sample — `actor: "U…"` is a redacted Slack user ID; `at` is ISO-8601):

```jsonl
{"at":"…","type":"token.usage","actor":"U…","provider":"anthropic-api","model":"claude-sonnet-4-6","inputTokens":12345,"outputTokens":678,"cacheReadTokens":9000}
```

`cacheReadTokens` / `cacheCreationTokens` present only when prompt caching was active.

### `pmk gateway audit` `Token usage` section

```
Token usage
  total in / out:                12.3k / 0.7k tokens
  cache read:                    9.0k tokens
  per-actor (top 3):             U… 8.2k in, U… 3.1k in, U… 1.0k in
  per-model:                     claude-sonnet-4-6 (12.3k in / 0.7k out)
```

Always rendered (zero counts visible as `(none)`). `cache read` line shown only when non-zero. No `$` calculation — that's deferred to a future release.

### Cap defaults bumped

| Env var | v0.11.1 default | v0.12.0 default |
|---|---|---|
| `PMK_MAX_SESSION_TOKENS` | 25_000 | 60_000 |
| `PMK_SEED_CAP` | 12_000 | 30_000 |
| `PMK_MRA_RESULT_CAP` | 16_000 | 40_000 |

If you're on the `claude-agent` fallback (no API key), tighten these back down — the SDK overhead is still in play on that path.

## Upgrade checklist (v0.11.x → v0.12.0)

1. `git pull && npm run cli:build` — no schema migration.
2. **If you have `ANTHROPIC_API_KEY` set:** restart the gateway. v0.12 auto-switches to `anthropic-api`. Verify with `tail -f ~/.pmk/gateway/events-$(date -u +%Y-%m).log | grep token.usage`.
3. **If you don't:** nothing to do — v0.12 invisible except for the bumped caps. Optionally run `pmk gateway init` to set the API key (writes to `gateway.json`).
4. After a week, run `pmk gateway audit --days 7` and check the `Token usage` section.
5. **To stay on `claude-agent`** explicitly: `export PMK_PROVIDER=claude-agent` (overrides auto). The fallback path is supported indefinitely.

## See also

- [v0.11 migration notes](./v0.11-migration.md) — preceding milestone
- [Changelog](../changelog.md)
```

- [ ] **Commit:** `git add apps/docs/docs/changelog.md apps/docs/docs/gateway/v0.12-migration.md && git commit -m "docs: changelog + migration notes for v0.12.0 anthropic-api default"`

---

## Task 12: Pre-tag verification + version bump + tag

**Files:** `package.json` × 7 via `scripts/bump-version.mjs`; tags + remote.

- [ ] **Step 1: Restart gateway with `ANTHROPIC_API_KEY` set, verify provider switch**

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # use a real key
npm --workspace packages/cli run start -- gateway start
```

Send any DM in Slack. Confirm reply works. Tail events log:

```bash
tail -f ~/.pmk/gateway/events-$(date -u +%Y-%m).log | grep token.usage
```

Expect ≥1 `token.usage` event per turn with non-zero `inputTokens`.

- [ ] **Step 2: Run audit**

```bash
npm --workspace packages/cli run start -- gateway audit --days 1
```

Confirm `Token usage` section renders with totals + per-actor + per-model breakdowns.

- [ ] **Step 3: Verify fallback path still works**

```bash
unset ANTHROPIC_API_KEY
# kill the running gateway, then:
npm --workspace packages/cli run start -- gateway start
```

Send any DM. Confirm reply still works (now via claude-agent). Tail events log — should see NO new `token.usage` events from this branch.

- [ ] **Step 4: Re-export the API key for production use**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# restart gateway again to land on the v0.12 default path
```

- [ ] **Step 5: Bump version**

```bash
node scripts/bump-version.mjs 0.12.0
```

(Expects 7 package.json files updated: root + 4 packages + 2 apps.)

- [ ] **Step 6: Commit + push branch + open PR**

```bash
git add -A
git commit -m "chore(release): bump workspace versions to 0.12.0"
git push -u origin feat/gateway-anthropic-api-default
gh pr create --base main --head feat/gateway-anthropic-api-default \
  --title "v0.12.0: gateway anthropic-api as default provider" \
  --body "..."  # body draft from changelog v0.12.0 entry
```

- [ ] **Step 7: After review + squash-merge**

```bash
git fetch origin
git tag -a v0.12.0 origin/main -m "v0.12.0: gateway anthropic-api as default provider

..." # body from changelog
git push origin v0.12.0
gh release create v0.12.0 --title "v0.12.0 — gateway anthropic-api as default provider" --notes "..." # from changelog
```

(Same tagging pattern as v0.11.1 — tag points at the squash commit on origin/main, avoiding the destructive `git reset --hard` if local main is diverged from a separate workflow.)

---

## Self-review checklist

- [x] **Spec coverage** — every section of the spec maps to a task:
  - 1 Resolver default flip → T4
  - 2 `gateway init` API-key prompt → T9
  - 3 Token-usage telemetry → T1 (ChatOptions field), T5 (emission), T6 (actor wiring)
  - 4 `TokenUsageEvent` type → T2
  - 5 Audit `Token usage` section → T7 (aggregator), T8 (formatter)
  - 6 Cap defaults bumped → T3
  - Components touched table → covered by T1-T11
  - Testing plan → covered as TDD inside each task
  - Release plan → T11 (changelog/migration), T12 (verify + bump + PR + tag)
  - Forward link (v0.11.2 harness, v0.13 deprecation, $-cost) → no implementation needed
- [x] **No placeholders** — every code block is real code; commands are runnable; no `// TODO`.
- [x] **Type consistency** — `ChatOptions.actor`, `TokenUsageEvent` fields (`inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheCreationTokens`), env var names (`PMK_MAX_SESSION_TOKENS`/`PMK_SEED_CAP`/`PMK_MRA_RESULT_CAP`/`PMK_PROVIDER`/`ANTHROPIC_API_KEY`), constants (`MAX_SESSION_TOKENS`/`SEED_CAP`/`MRA_RESULT_CAP`), `AuditReport.tokenUsage` shape, formatter helper `formatTokens` — all referenced consistently across tasks.


