# Gateway `anthropic-api` as Default Provider — Design Spec

- Date: 2026-05-08
- Target release: v0.12.0
- Status: Draft (awaiting implementation plan)
- Owner: Hanfour Huang

## Background

v0.11.1 hardened the gateway against `msg_too_long` by lowering caps,
fixing the prune-ordering bug, and adding an auto-retry path. Cause #2
from the 2026-05-07 incident — `claude-agent-sdk` spawning the local
`claude` CLI and inheriting the host's `~/.claude/` config (skills,
hooks, MCP server descriptions) as un-budgeted system context — was
absorbed in v0.11.1 by lowering `MAX_SESSION_TOKENS` 60_000 → 25_000,
not eliminated.

The forward-link in
`apps/docs/docs/plans/2026-05-07-gateway-msg-too-long-hardening.md`
identified a v0.12 follow-up: switch the gateway provider default from
`claude-agent-sdk` to the Anthropic SDK (`@anthropic-ai/sdk`),
eliminating the SDK-inherited host context as a budget unknown so caps
can return to operationally useful values.

A scope discovery during brainstorming surfaced that
`AnthropicApiKeyProvider` already exists, fully wired into the
resolver, with proper streaming and role-separated messages. v0.12 is
therefore much smaller than the original forward-link suggested — it
is primarily a default-flip + cost telemetry release, not a build-the-
new-provider release.

## Goals

- Make `anthropic-api` the auto-resolved default provider when an
  Anthropic API key is available.
- Keep `claude-agent-sdk` as a soft-flip fallback for users without an
  API key (zero breakage on upgrade for that branch).
- Restore cap defaults to operationally useful values
  (`MAX_SESSION_TOKENS` back to 60_000, single-message caps relaxed)
  now that SDK overhead is no longer in play on the default path.
- Surface per-call token usage in `events.log` and `pmk gateway audit`
  so operators can see what they're spending without doing math.

## Non-goals (v0.12.0)

- Calculating cost in dollars (pricing changes; not our job).
- Deprecating the `claude-agent` provider — it stays as a soft-flip
  fallback indefinitely. Re-evaluate in v0.13+ based on usage data
  from the new `token.usage` audit section.
- Changing the default model (`claude-sonnet-4-6` stays).
- Reworking `pmk apply` / `pmk discuss` / `pmk explore` / `pmk ask` /
  `pmk debug` / `pmk case` — they share `resolveProvider`, so they
  automatically benefit from the default flip with no CLI command
  surface changes.
- Building a `SlackGateway` integration harness (still tracked as a
  separate v0.11.2 follow-up; orthogonal to the provider switch).

## Design

### 1. Resolver default flip (soft-flip)

In `packages/cli/src/llm/resolver.ts`'s `autoResolve(config)`, swap
the order:

Before (v0.11.x):

```
1. local `claude` binary on PATH → ClaudeAgentSdkProvider
2. ANTHROPIC_API_KEY (or config.apiKey) → AnthropicApiKeyProvider
3. fail
```

After (v0.12.0):

```
1. ANTHROPIC_API_KEY (or config.apiKey) → AnthropicApiKeyProvider
2. local `claude` binary on PATH → ClaudeAgentSdkProvider
3. fail
```

Migration semantics — zero-touch for both branches:

| Existing user state | After v0.12 upgrade |
|---|---|
| Has `ANTHROPIC_API_KEY` set | Auto-switches to `anthropic-api`. Sees `Token usage` section in audit. SDK overhead gone, may see fewer `context.exceeded` events. |
| No API key, has `claude` CLI | Stays on `claude-agent`. No behavior change. v0.12 is invisible to them except for the bumped cap defaults. |
| Neither | Same `NoProviderAvailableError`, with updated message recommending the API-key path first. |

`PMK_PROVIDER=claude-agent` continues to force the legacy path
explicitly. `PMK_PROVIDER=anthropic-api` continues to require the API
key. Both remain unchanged.

### 2. `gateway init` API-key prompt

In `packages/cli/src/commands/gateway.ts`'s `initCmd`, after the
existing Slack token prompts (App-Level Token, Bot User OAuth Token),
add an Anthropic API-key prompt:

```
Anthropic API key (sk-ant-...) [unchanged on enter; leave blank to use ANTHROPIC_API_KEY env var]:
```

Stored in `~/.pmk/gateway.json` `apiKey` field at mode 0600 (same as
Slack tokens, since the file's permissions are already set on the
existing init path). Empty input keeps the existing `apiKey` value if
one is already in the file, otherwise leaves it `undefined` so env
var resolution continues to work.

Init copy gains a one-time explanation banner above the prompt:

```
v0.12+: pmk gateway prefers the Anthropic API directly (no SDK overhead).
If you skip this prompt, set ANTHROPIC_API_KEY in your environment, or
keep the legacy claude-agent path with PMK_PROVIDER=claude-agent.
```

### 3. Token-usage telemetry

In `packages/cli/src/llm/anthropic-api.ts`'s `chat()` method, after
the existing `for await (const event of stream)` loop completes,
extract usage tokens from `stream.finalMessage()` (or accumulate
`message_start.message.usage` and `message_delta.usage` during the
loop) and emit a `token.usage` event:

```ts
appendGatewayEvent({
  type: "token.usage",
  actor,                 // threaded from caller (similar to T9 actor threading)
  provider: "anthropic-api",
  model: this.config.model,
  inputTokens: usage.input_tokens,
  outputTokens: usage.output_tokens,
  cacheReadTokens: usage.cache_read_input_tokens,        // optional, when prompt-caching active
  cacheCreationTokens: usage.cache_creation_input_tokens, // optional
});
```

This requires threading `actor` into `LlmProvider.chat()`'s options
(currently `ChatOptions` only has `onToken`). Add an optional
`actor?: string` field to `ChatOptions`. Existing call sites in CLI
commands that don't have a Slack-actor concept pass `actor:
"cli:hanfourhuang"` or similar — or pass `undefined` and the event is
suppressed (no actor → no event, since the audit aggregator buckets
per-actor).

`ClaudeAgentSdkProvider.chat()` does NOT emit `token.usage` events —
the SDK doesn't surface per-call usage in a comparable way, and the
goal of the event is to instrument the new default path. The audit
aggregator handles a missing or zero `tokenUsage` rollup gracefully
(renders `(none)`).

### 4. New `TokenUsageEvent` type

In `packages/cli/src/gateway/events.ts`:

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

Add to `GatewayEvent` union and `VALID_TYPES` set. JSDoc explains
operator intent (per-call usage, no $-conversion in pmk).

### 5. Audit `Token usage` section

In `packages/cli/src/gateway/audit.ts`, extend `AuditReport`:

```ts
tokenUsage: {
  total: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
  perActor: Array<{ actor: string; inputTokens: number; outputTokens: number }>;
  perModel: Array<{ model: string; inputTokens: number; outputTokens: number }>;
};
```

Aggregate by switching on `e.type === "token.usage"` inside the
existing event for-loop. Top-3 per-actor (with `OTHER` tail bucket
mirroring the existing `formatTopWithOther` pattern).

In `audit-format.ts`, render the section after `Context safety`:

```
Token usage
  total in / out:                12.3k / 0.7k tokens
  cache read:                    9.0k tokens
  per-actor (top 3):             U… 8.2k in, U… 3.1k in, U… 1.0k in
  per-model:                     claude-sonnet-4-6 (12.3k in / 0.7k out)
```

Section always rendered (zero-counts visible as `(none)`), matching
the v0.11.1 `Context safety` section convention. `cache read` line
shown only when non-zero (cache may not always be active).

### 6. Cap defaults bumped

In `packages/cli/src/gateway/messaging.ts`, lift the env-var fallback
defaults (env var override behavior unchanged):

| Constant | v0.11.1 default | v0.12.0 default |
|---|---|---|
| `MAX_SESSION_TOKENS` | 25_000 | **60_000** (back to pre-v0.11.1 value) |
| `SEED_CAP` | 12_000 | **30_000** |
| `MRA_RESULT_CAP` | 16_000 | **40_000** |

JSDoc on each constant updated to note "v0.12.0 raised default with
anthropic-api default — SDK overhead removed; tighten with
PMK_*_CAP for hosts on the claude-agent fallback path".

The retry path (`forcePruneToMinimum`, scissors marker, `:x:` hard-
fail) remains untouched. All v0.11.1 layered defenses stay in place;
only the budgets relax.

## Components touched

| File | Change kind |
|---|---|
| `packages/cli/src/llm/resolver.ts` | `autoResolve()` order swap; updated `NoProviderAvailableError` message |
| `packages/cli/src/llm/anthropic-api.ts` | Token-usage event emission after stream completion; thread `actor` from `ChatOptions` |
| `packages/cli/src/llm/provider.ts` | Add optional `actor?: string` to `ChatOptions` |
| `packages/cli/src/commands/gateway.ts` | Add API-key prompt + explanation banner to `initCmd` |
| `packages/cli/src/gateway/events.ts` | Add `TokenUsageEvent` interface, extend union and `VALID_TYPES` |
| `packages/cli/src/gateway/audit.ts` | Add `tokenUsage` field to `AuditReport`, aggregate from event log |
| `packages/cli/src/gateway/audit-format.ts` | Render `Token usage` section after `Context safety` |
| `packages/cli/src/gateway/messaging.ts` | Lift `MAX_SESSION_TOKENS` / `SEED_CAP` / `MRA_RESULT_CAP` defaults; JSDoc rewrites |
| `packages/cli/src/gateway/slack/index.ts` | Pass `actor: userId` in `ChatOptions` for both `chatWithContextRetry` and `synthesiseAfterMra` LLM calls |
| `packages/cli/src/llm/claude-agent.ts` | Add a brief comment at the top noting v0.12 fallback role; no behavioral change |
| `packages/cli/test/resolver.test.ts` (new) | Auto-resolve order tests |
| `packages/cli/test/llm-anthropic-api.test.ts` (new) | Token-usage emission unit tests |
| `packages/cli/test/messaging.test.ts` (extend) | Update cap-default assertions to v0.12 values |
| `packages/cli/test/gateway-events.test.ts` (extend) | `token.usage` round-trip |
| `packages/cli/test/gateway-audit.test.ts` (extend) | `tokenUsage` aggregation test |
| `packages/cli/test/gateway-audit-format.test.ts` (extend) | `Token usage` section rendering (non-zero + zero cases) |
| `apps/docs/docs/changelog.md` | v0.12.0 entry |
| `apps/docs/docs/gateway/v0.12-migration.md` (new) | Operator-facing summary mirroring v0.11 migration doc shape |

## Testing plan

| Type | Coverage |
|---|---|
| Unit | `resolver.ts` autoResolve order: apiKey present → anthropic-api; apiKey absent + claude binary → claude-agent; both missing → NoProviderAvailableError. |
| Unit | `anthropic-api.ts` token-usage emission: mock `client.messages.stream()` to yield `message_start` + `message_delta` events with usage fields; assert `appendGatewayEvent` called with the right shape; verify no event when `actor` is undefined. |
| Unit | `events.ts` round-trip for `token.usage` (extends `gateway-events.test.ts`). |
| Unit | `messaging.ts` cap defaults — flip the existing v0.11.1 default-value assertions to v0.12.0 values (60k / 30k / 40k). |
| Unit | `audit.ts` `tokenUsage` aggregation: seed N `token.usage` events with mixed actors / models / cache fields; assert totals, top-3 per-actor, per-model breakdown. |
| Unit | `audit-format.ts` `Token usage` section: non-zero rendering with cache line; zero rendering with `(none)`; cache line suppressed when zero. |

No new e2e tests. Live verification path covered in the release plan.

The `gateway init` API-key prompt is interactive and exercised by the
release-plan manual verification step. If a prompt-helper extraction
(e.g. `promptForApiKey()`) lands naturally during implementation, a
unit test for it should be added; if not, manual verify is acceptable.

## Release plan

- Target version: **v0.12.0** (minor bump — auto-resolution semantics
  change is user-visible, even though most existing users see no
  behavior change).
- Workflow: per `feedback_release_workflow.md`, v0.x.0 ships as a
  squash-merge feature PR with explicit review (matches v0.11.1
  pattern even though that was technically a patch).
- Pre-tag verification:
  1. Set `ANTHROPIC_API_KEY` in env, restart gateway. Confirm startup
     log says provider=anthropic-api (or absence of "claude path
     found" line). Send any DM, verify reply works.
  2. Tail `events-2026-MM.log | grep token.usage` — expect one event
     per turn with non-zero `inputTokens`.
  3. Run `pmk gateway audit --days 1` — expect `Token usage` section
     populated with per-actor + per-model breakdowns.
  4. Unset `ANTHROPIC_API_KEY` and restart gateway. Confirm fallback
     to `claude-agent` path runs normally (smoke test for the soft-
     flip fallback). No `token.usage` events should be emitted from
     this branch.
- Changelog entry for v0.12.0:
  `gateway: anthropic-api as default provider — eliminates claude-agent-sdk's host-context overhead, restores cap headroom (MAX_SESSION_TOKENS 25k → 60k, SEED_CAP 12k → 30k, MRA_RESULT_CAP 16k → 40k), adds per-call token.usage telemetry with new audit Token usage section, gateway init now prompts for ANTHROPIC_API_KEY. claude-agent stays as soft-flip fallback for users without an API key — zero breakage.`

## Forward link: post-v0.12

- **v0.11.2 (parallel track):** SlackGateway integration harness so
  the seed-cap / mra-result-cap / prune-ordering / retry-prefix
  wiring sites get direct integration coverage. Orthogonal to v0.12.
- **v0.13+ candidate:** evaluate deprecating `claude-agent` based on
  3-6 months of `token.usage` audit data. If users have de-facto
  migrated, mark deprecated; remove in a later major.
- **v0.13+ candidate:** $-cost calculation in audit, gated on
  Anthropic publishing a stable price-table API or pmk maintaining a
  manually-updated table.

## Open questions

None at draft time. Decisions on scope (full default flip), migration
UX (soft flip), init prompt (write to gateway.json), cap aggressiveness
(medium relaxation back to v0.11.0 levels), and cost telemetry depth
(token counts, no $-math) were resolved during the brainstorming
session that produced this spec on 2026-05-08.
