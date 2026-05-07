# Gateway `msg_too_long` Hardening — Design Spec

- Date: 2026-05-07
- Target release: v0.11.1
- Status: Draft (awaiting implementation plan)
- Owner: Hanfour Huang

## Background

Production incident on 2026-05-07: a Slack thread under `#新頻道`
(channel `C0AVD1XD946`, thread `1778139665.927099`) returned
`pmk 內部錯誤：An API error occurred: msg_too_long` after several
successful `mra-ask` rounds. Workaround was to delete the thread's
`chat-session.json`. We want this class of failure to not reach
production users again.

Investigation surfaced four root causes:

1. **Prune ordering bug** — `runFreeChatTurn` in
   `packages/cli/src/gateway/slack/index.ts:545` calls
   `pruneSessionIfNeeded` *after* the LLM call, not before. Once a
   session is over budget, the next turn fails before pruning can
   recover it. The error path also short-circuits the prune, so the
   session stays bloated for every subsequent turn.
2. **SDK overhead unaccounted-for** — `ClaudeAgentSdkProvider` spawns
   the local `claude` CLI, which inherits the host's `~/.claude/`
   config (skills, hooks, MCP server descriptions). On a heavy host
   the inherited system context can add tens of thousands of tokens
   on top of every request. The current `MAX_SESSION_TOKENS=60000`
   default leaves no headroom for this.
3. **Single-message bloat** — `defaultIngest: "mra:--all"` produces
   an 88,292-char (~25k token) PKB seed that lives in `messages[0..1]`
   forever (`PKB_SEED_PREFIX` bypasses prune). `mra-ask` results are
   pushed into session history without size limits. A single one of
   these can blow the budget on its own.
4. **No graceful degradation** — when `msg_too_long` does fire, the
   raw Anthropic error message is forwarded to Slack and the user is
   stuck until an operator clears the session file by hand.

## Goals

- Eliminate `msg_too_long` from the user-visible failure surface in
  v0.11.1.
- Keep the existing `claude-agent-sdk` provider as default; do not
  break auth flow or billing model.
- Preserve operator visibility into context-safety events through
  `events.log` and `pmk gateway audit`.
- Lay forward link to a v0.12 effort that addresses cause #2
  architecturally.

## Non-goals (v0.11.1)

- Switching gateway default provider to `anthropic-api`. (Tracked in
  the v0.12 roadmap stub at the end of this spec.)
- Reworking the PKB-seed mechanism into a retrieval-only model.
- Reshaping `mra-ask` payloads.
- Any change to Slack-facing UI beyond the new prefix/error strings.

## Design

### 1. Source-side fixes

#### 1.1 Move `pruneSessionIfNeeded` before the LLM call

In `packages/cli/src/gateway/slack/index.ts` (`runFreeChatTurn`,
currently around line 525–605), reorder so that:

1. The new user turn is composed (`text`).
2. `retrievalPrefix` is built from `searchAtoms`.
3. `session.approxTokens` is recomputed **including** `retrievalPrefix`
   plus the new user text.
4. `pruneSessionIfNeeded(session, { extra: retrievalPrefix, newUser: text })`
   runs.
5. Only then `llm.chat` is called with
   `[...retrievalPrefix, ...session.messages, { role: "user", content: text }]`.
6. Post-call: assistant reply pushed; `approxTokens` recomputed; save
   session. (No second prune call here — it is now redundant.)

This is the single most important change; it closes the "fails-then-
fails-forever" loop.

#### 1.2 Account for `retrievalPrefix` in the prune budget

In `packages/cli/src/gateway/messaging.ts`:

- Extend `approxTokensFor(messages: ChatMessage[])` to optionally
  accept an `extra: ChatMessage[]` second argument and sum its content
  too.
- Extend `pruneSessionIfNeeded(session, opts?)` so callers can pass
  `{ extra: ChatMessage[]; newUser?: string }` representing content
  that will be sent to the model on the next call but is not stored
  in `session.messages`. The function uses these for the budget check
  but does not mutate them.

This stops `retrievalPrefix` from being a hidden charge on every
turn.

#### 1.3 Cap individual messages at write-time

New helper in `messaging.ts`:

```ts
export function capMessageContent(
  content: string,
  limit: number,
  kind: "seed" | "mra-result",
): { content: string; capped: boolean; originalChars: number };
```

When `content.length > limit`, return `content.slice(0, limit)` plus
a marker line:

```
…（已自動截斷，原長度 N，超過 ${kind} cap ${limit}，完整內容仍在 host）
```

Apply at two sites in `slack/index.ts`:

- `buildIngestSeed` result, before pushing to `session.messages[0]`
  (cap = `PMK_SEED_CAP`, default 12000).
- `buildMraSuccessMessage` result, before pushing to
  `session.messages` inside `synthesiseAfterMra` (cap =
  `PMK_MRA_RESULT_CAP`, default 16000).

The cap is applied **once**, at write-time. Pruning later does not
re-cap; sessions saved before this change keep their full historical
content (no migration).

#### 1.4 Lower `MAX_SESSION_TOKENS` default

`messaging.ts`: change the default in the
`PMK_MAX_SESSION_TOKENS` parser from `60_000` to `25_000`. The old
60k value assumed ~70% of a 90k DM-context budget and ignored SDK
overhead; 25k leaves explicit headroom for system prompt + retrieval
prefix + SDK-inherited host context + the new turn + the model's
reply.

### 2. Retry path on `msg_too_long`

#### 2.1 Provider-level: typed error

In `packages/cli/src/llm/claude-agent.ts`, wrap the `query()` loop
in try/catch. If the underlying error message matches
`/msg_too_long|prompt is too long|context.+exceed/i`, throw a typed
sentinel:

```ts
export class PmkContextTooLongError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super("PmkContextTooLongError");
    this.cause = cause;
  }
}
```

All other errors propagate unchanged.

#### 2.2 Gateway-level: force-prune + retry

In `slack/index.ts:runFreeChatTurn`, wrap the `llm.chat` call in
try/catch:

```
try { full = await llm.chat(...) }
catch (err) {
  if (!(err instanceof PmkContextTooLongError)) throw err;
  appendGatewayEvent({ type: "context.exceeded", actor: userId, ... });

  const dropped = forcePruneToMinimum(session);
  appendGatewayEvent({ type: "context.force-pruned", actor: userId, droppedPairs: dropped });

  try {
    full = await llm.chat(systemPrompt, [...retrievalPrefix, ...session.messages, { role: "user", content: text }], ...);
    visiblePrefix = `:scissors: 對話過長，已自動裁掉 ${dropped} 輪舊訊息\n\n`;
  } catch (err2) {
    await this.web.chat.update({
      channel: channelId,
      ts: String(placeholder.ts),
      text: ":x: 對話太長，請開新 thread 重新提問",
    });
    return;
  }
}
```

`forcePruneToMinimum(session)` (new export in `messaging.ts`):
keeps the seed pair (if present) plus the most recent user/assistant
pair, drops everything else, returns `droppedPairs`. It is idempotent
and does not consult `MAX_SESSION_TOKENS` — this is the
last-resort path.

The visible prefix `:scissors: …` is prepended to `visible` only on
the retry-success branch so users have an explanation for missing
context. Slack `chat.update` is used as before.

The same retry wrapper applies to the `synthesiseAfterMra`
(mra-ask follow-up) call site, since that call is the most likely
single trigger of `msg_too_long` in practice.

### 3. Observability

Three new event types append to `events-YYYY-MM.log` (existing
JSONL format, no schema migration needed). Field semantics:

- `at` — ISO-8601 timestamp string, matches existing log convention
  (e.g. `2026-05-07T07:39:55.339Z`).
- `type` — string literal: `context.exceeded` / `context.force-pruned`
  / `message.capped`.
- `actor` — Slack user ID (sample values redacted as `U…`).
- `phase` — for `context.exceeded`: enum string `first-call` |
  `synthesise`.
- `kind` — for `message.capped`: enum string `seed` | `mra-result`.

Sample lines (synthetic values):

```jsonl
{"at":"…","type":"context.exceeded","actor":"U…","sessionTokensBefore":31578,"retrievalAtoms":1,"phase":"first-call"}
{"at":"…","type":"context.force-pruned","actor":"U…","droppedPairs":6,"tokensAfter":4200}
{"at":"…","type":"message.capped","actor":"U…","kind":"seed","originalChars":88292,"cappedChars":12000}
```

`pmk gateway audit` rollup
(`packages/cli/src/gateway/audit.ts` + `audit-format.ts`) gains a
new `Context safety` section listing, for the requested window:

- count of `context.exceeded` events (broken down by `phase`)
- count of `context.force-pruned` events
- count of `message.capped` events (broken down by `kind`)

These give operators a feedback signal: if `context.exceeded` is
non-zero in a week, lower the relevant cap env var.

### 4. Tunables (env vars)

| Env var | Default | Effect |
|---|---|---|
| `PMK_MAX_SESSION_TOKENS` | `25000` | Soft cap for session pruning. Existing var, default lowered from 60000. |
| `PMK_SEED_CAP` | `12000` | Maximum chars for the PKB seed message. New. |
| `PMK_MRA_RESULT_CAP` | `16000` | Maximum chars for any `mra-ask` result pushed into session history. New. |

All three parse identically: positive integer or fall back to default.

## Components touched

| File | Change kind |
|---|---|
| `packages/cli/src/gateway/messaging.ts` | Add `capMessageContent`, `forcePruneToMinimum`, env-var parsers; extend `approxTokensFor` and `pruneSessionIfNeeded` signatures; lower default of `MAX_SESSION_TOKENS`. |
| `packages/cli/src/gateway/slack/index.ts` | Reorder prune-before-call; apply `capMessageContent` at seed + mra-result write sites; wrap both LLM calls with retry path. |
| `packages/cli/src/llm/claude-agent.ts` | Throw `PmkContextTooLongError` on matching errors. |
| `packages/cli/src/gateway/events.ts` (or wherever `appendGatewayEvent` lives) | Add the three new event-type literals to the union; no runtime change needed if writer accepts arbitrary objects. |
| `packages/cli/src/gateway/audit.ts` + `audit-format.ts` | Aggregate + render the new `Context safety` section. |
| `packages/cli/test/messaging.test.ts` | Unit tests for new helpers + extended signatures. |
| `packages/cli/test/llm-claude-agent.test.ts` (new) | Verify error wrapping. |
| `packages/cli/test/gateway.test.ts` | Integration tests: prune-ordering, retry-path-success, retry-path-fail, single-message capping. |
| `apps/docs/docs/changelog.md` | v0.11.1 entry. |
| `apps/docs/docs/gateway/v0.11-migration.md` | Append a "v0.11.1: context-safety hardening" section pointing to env vars + new audit fields. |

## Testing plan

| Type | Coverage |
|---|---|
| Unit | `capMessageContent` boundary cases (length === limit, > limit, undefined limit, multibyte). |
| Unit | `approxTokensFor(messages, extra)` includes `extra` content; backward-compatible when `extra` omitted. |
| Unit | `pruneSessionIfNeeded` with new `extra`/`newUser` opts is idempotent and respects budget. |
| Unit | `forcePruneToMinimum` keeps seed pair + last pair, drops middle, idempotent. |
| Unit | `claude-agent.chat` throws `PmkContextTooLongError` for `msg_too_long`-shaped errors and propagates other errors unchanged. |
| Integration | `runFreeChatTurn` happy path: prune is invoked **before** `llm.chat` (verify via spy call order). |
| Integration | Retry path success: first `llm.chat` throws sentinel → session is force-pruned → second `llm.chat` succeeds → reply has `:scissors: …` prefix → `context.exceeded` and `context.force-pruned` events written. |
| Integration | Retry path fail: both calls throw sentinel → user sees `:x: 對話太長，請開新 thread 重新提問` → no assistant message persisted. |
| Integration | `mra-result` longer than `PMK_MRA_RESULT_CAP` is capped before being pushed to `session.messages` and writes a `message.capped` event. |
| Integration | `audit.ts` `Context safety` section reports correct counts over a synthetic event log. |

No e2e tests added — this is internal prompt-shaping; Slack-side
behaviour for the happy path is unchanged, and the retry-path
strings (`:scissors:`, `:x: …`) are short enough to be covered by
integration assertions on Slack mock calls.

## Release plan

- Target version: **v0.11.1**.
- Workflow: per `feedback_release_workflow.md`, v0.x.1 normally
  goes via commit-on-main. This patch adds 3 new env vars + 3 new
  event types — borderline minor surface — so it ships as a single
  squash-merge feature PR with explicit review (not skipped).
- Pre-tag verification:
  1. Restart gateway against the previously-bloated thread
     `1778139665.927099` (we already cleared it on 2026-05-07; let
     it accumulate again to mid-budget) and confirm prune-before-call
     fires without `msg_too_long`.
  2. Force a synthetic `msg_too_long` (set `PMK_MAX_SESSION_TOKENS=1`
     for one run) to exercise the retry path live.
  3. Run `pmk gateway audit --days 1` and check the new `Context
     safety` section renders.
- Changelog entry under v0.11.1: `gateway: msg_too_long hardening
  — prune-before-call, single-message caps for PKB seed and mra
  results, auto-retry with abridged history, three new
  PMK_*_CAP env vars, three new context.* event types, audit
  rollup section`.

## Forward link: v0.12 — anthropic-api provider as gateway default

v0.11.1 absorbs the SDK-overhead unknown by lowering caps; it does
not eliminate the unknown itself. v0.12 should let the gateway opt
out of `claude-agent-sdk` and call Anthropic's API directly.

Reasons:

- Removes the "host's `~/.claude/` config bleeds into every gateway
  request" variable, making token budgets predictable.
- The gateway does not need agentic tools; the SDK is overkill.
- Operator can monitor cost and rate limits at the API level.

Costs (to be planned in v0.12 spec, not here):

- Provider abstraction touchup; `gateway init` flow gains an API-key
  step.
- Auth & billing user experience changes (subscription → token
  billing).
- Migration guide for existing v0.11.x users.

Cap mechanism from v0.11.1 stays in v0.12; only the budgets relax
toward the model's true context window.

## Open questions

None at draft time. (Decisions on cap aggressiveness, retry UX, and
roadmap scope were resolved during the brainstorming session that
produced this spec on 2026-05-07.)
