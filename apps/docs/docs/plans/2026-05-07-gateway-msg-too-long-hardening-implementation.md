# Gateway `msg_too_long` Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate `msg_too_long` from the gateway's user-visible failure surface in v0.11.1 by fixing prune ordering, capping single-message bloat, and adding an auto-retry path with audit trail.

**Architecture:** Layered defense in `packages/cli/src/gateway/`. (1) New helpers in `messaging.ts` for write-time content caps and last-resort pruning. (2) Provider-level typed error in `claude-agent.ts`. (3) Reordering + retry wrapper around the two LLM call sites in `slack/index.ts`. (4) Three new event-types feed `pmk gateway audit`'s new `Context safety` section.

**Tech Stack:** TypeScript, `node:test` runner via `tsx`, `@anthropic-ai/claude-agent-sdk`, `@slack/socket-mode` + `@slack/web-api`. Tests under `packages/cli/test/<area>.test.ts`. Run all: `npm --workspace packages/cli test`. Single file: `node --import tsx --test test/<file>.test.ts` (run from `packages/cli/`).

**Source spec:** `apps/docs/docs/plans/2026-05-07-gateway-msg-too-long-hardening.md` (commit 6773eae).

---

## File map

| Path | Touched by |
|---|---|
| `packages/cli/src/gateway/messaging.ts` | T1, T2, T3, T4, T5, T9 |
| `packages/cli/src/gateway/slack/index.ts` | T3, T8, T9, T10, T11, T12 |
| `packages/cli/src/llm/claude-agent.ts` | T7 |
| `packages/cli/src/gateway/events.ts` | T6 |
| `packages/cli/src/gateway/audit.ts` | T13 |
| `packages/cli/src/gateway/audit-format.ts` | T14 |
| `packages/cli/test/messaging.test.ts` (extend) | T1-T5 |
| `packages/cli/test/llm-claude-agent.test.ts` (new) | T7 |
| `packages/cli/test/gateway.test.ts` (extend) | T8, T10, T11, T12 |
| `packages/cli/test/gateway-events.test.ts` (extend) | T6, T9 |
| `packages/cli/test/gateway-audit.test.ts` (extend) | T13 |
| `packages/cli/test/gateway-audit-format.test.ts` (extend) | T14 |
| `apps/docs/docs/changelog.md` | T15 |
| `apps/docs/docs/gateway/v0.11-migration.md` | T15 |

## Conventions

- TDD: write failing test → run (FAIL) → minimal impl → run (PASS) → commit. Steps below show test + impl; the run-fail / run-pass invocations are implicit but **mandatory**.
- Commit messages follow existing repo style: `<type>(<scope>): <description>`.
- Each commit must leave `npm --workspace packages/cli test` green.
- No version bump inside individual tasks. Version bump is T16 only.
- Worktree: per `superpowers:using-git-worktrees`, the executor should create an isolated worktree before T1.

---

## Task 1: `capMessageContent` helper

**Files:** modify `packages/cli/src/gateway/messaging.ts`; extend `packages/cli/test/messaging.test.ts`.

- [ ] **Test** (append to messaging.test.ts):

```ts
import { capMessageContent } from "../src/gateway/messaging";
describe("capMessageContent", () => {
  it("returns content unchanged when within limit", () => {
    const r = capMessageContent("hello", 10);
    assert.deepEqual(r, { content: "hello", capped: false, originalChars: 5 });
  });
  it("truncates over-limit content and reports originalChars", () => {
    const r = capMessageContent("x".repeat(100), 20);
    assert.equal(r.capped, true);
    assert.equal(r.originalChars, 100);
    assert.ok(r.content.startsWith("x".repeat(20)));
    assert.ok(r.content.includes("truncated"));
  });
  it("boundary: length === limit returns unchanged", () => {
    assert.equal(capMessageContent("12345", 5).capped, false);
  });
  it("counts chars not bytes (multibyte safe)", () => {
    assert.equal(capMessageContent("你好你好你好", 10).originalChars, 6);
  });
});
```

- [ ] **Impl** (insert after existing `truncate` in messaging.ts, ~line 24):

```ts
export interface CapResult {
  content: string;
  capped: boolean;
  originalChars: number;
}

export function capMessageContent(content: string, limit: number): CapResult {
  if (content.length <= limit) {
    return { content, capped: false, originalChars: content.length };
  }
  return {
    content: truncate(content, limit),
    capped: true,
    originalChars: content.length,
  };
}
```

- [ ] **Commit:**

```bash
git add packages/cli/src/gateway/messaging.ts packages/cli/test/messaging.test.ts
git commit -m "feat(gateway): capMessageContent helper for write-time bloat caps"
```

---

## Task 2: Lower `MAX_SESSION_TOKENS` default + add `SEED_CAP` / `MRA_RESULT_CAP`

**Files:** modify `messaging.ts`; extend `messaging.test.ts`.

- [ ] **Test:**

```ts
import { MAX_SESSION_TOKENS, SEED_CAP, MRA_RESULT_CAP } from "../src/gateway/messaging";
describe("messaging cap defaults", () => {
  it("MAX_SESSION_TOKENS default is 25_000 (v0.11.1)", () => {
    assert.equal(MAX_SESSION_TOKENS, 25_000);
  });
  it("SEED_CAP default is 12_000", () => {
    assert.equal(SEED_CAP, 12_000);
  });
  it("MRA_RESULT_CAP default is 16_000", () => {
    assert.equal(MRA_RESULT_CAP, 16_000);
  });
});
```

(Env-var override behaviour is exercised by the existing test infrastructure for `PMK_MAX_SESSION_TOKENS`; the new vars use the same parser so we trust transitively.)

- [ ] **Impl:** Replace the `MAX_SESSION_TOKENS` IIFE (~line 138-142) with:

```ts
function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const MAX_SESSION_TOKENS = parsePositiveIntEnv("PMK_MAX_SESSION_TOKENS", 25_000);
export const SEED_CAP = parsePositiveIntEnv("PMK_SEED_CAP", 12_000);
export const MRA_RESULT_CAP = parsePositiveIntEnv("PMK_MRA_RESULT_CAP", 16_000);
```

Add a one-line comment above each constant explaining purpose (mirrors existing tone).

- [ ] **Commit:**

```bash
git commit -am "feat(gateway): lower MAX_SESSION_TOKENS to 25k + add SEED_CAP/MRA_RESULT_CAP env knobs"
```

---

## Task 3: Export `approxTokensFor` with `extra` param; drop slack duplicate

**Files:** modify `messaging.ts` and `slack/index.ts`; extend `messaging.test.ts`.

- [ ] **Test:**

```ts
import { approxTokensFor } from "../src/gateway/messaging";
describe("approxTokensFor", () => {
  it("sums primary message content / 3.5", () => {
    assert.equal(approxTokensFor([{ role: "user", content: "x".repeat(35) }]), 10);
  });
  it("includes extra in total", () => {
    const got = approxTokensFor(
      [{ role: "user", content: "x".repeat(35) }],
      [{ role: "user", content: "y".repeat(35) }],
    );
    assert.equal(got, 20);
  });
  it("backward-compatible: omitted extra ≡ []", () => {
    const a = approxTokensFor([{ role: "user", content: "ab" }]);
    const b = approxTokensFor([{ role: "user", content: "ab" }], []);
    assert.equal(a, b);
  });
});
```

- [ ] **Impl in `messaging.ts`** (replace private function around line 165):

```ts
export function approxTokensFor(
  messages: ChatMessage[],
  extra: ChatMessage[] = [],
): number {
  let total = 0;
  for (const m of messages) total += m.content.length;
  for (const m of extra) total += m.content.length;
  return Math.ceil(total / 3.5);
}
```

- [ ] **Impl in `slack/index.ts`:** delete local `approxTokensFor` (lines 130-136), and add `approxTokensFor` to the existing import from `../messaging`:

```ts
import {
  approxTokensFor,
  buildIngestSeed,
  buildMraFailureMessage,
  buildMraSuccessMessage,
  pruneSessionIfNeeded,
  truncate,
} from "../messaging";
```

- [ ] **Commit:**

```bash
git commit -am "refactor(gateway): export approxTokensFor with extra-param; drop slack duplicate"
```

---

## Task 4: Extend `pruneSessionIfNeeded` to accept `{extra, newUser}`

**Files:** modify `messaging.ts`; extend `messaging.test.ts`.

- [ ] **Test:**

```ts
describe("pruneSessionIfNeeded with opts", () => {
  it("recomputes approxTokens including extra+newUser", () => {
    const session = {
      messages: [
        { role: "user" as const, content: "Q" },
        { role: "assistant" as const, content: "A" },
      ],
      approxTokens: 0,
    };
    pruneSessionIfNeeded(session, {
      extra: [{ role: "user", content: "x".repeat(7000) }],
      newUser: "y".repeat(7000),
    });
    assert.ok(session.approxTokens > 3000);
  });
  it("backward-compatible: omitted opts behaves like before", () => {
    const session = {
      messages: [{ role: "user" as const, content: "hi" }, { role: "assistant" as const, content: "ok" }],
      approxTokens: 0,
    };
    const r = pruneSessionIfNeeded(session);
    assert.equal(r.pruned, false);
  });
});
```

- [ ] **Impl** in `messaging.ts`. Add interface and update signature:

```ts
export interface PruneOpts {
  extra?: ChatMessage[];
  newUser?: string;
}

export function pruneSessionIfNeeded(
  session: SessionLike,
  opts: PruneOpts = {},
): PruneResult {
  const extras: ChatMessage[] = [
    ...(opts.extra ?? []),
    ...(opts.newUser ? [{ role: "user" as const, content: opts.newUser }] : []),
  ];
  session.approxTokens = approxTokensFor(session.messages, extras);
  // … existing body unchanged from the early-return check onward
```

At the end of the function (where `session.approxTokens = approxTokensFor(session.messages)` recomputes after a prune), pass `extras` too: `approxTokensFor(session.messages, extras)`.

- [ ] **Commit:**

```bash
git commit -am "feat(gateway): pruneSessionIfNeeded counts retrievalPrefix + newUser in budget"
```

---

## Task 5: `forcePruneToMinimum`

**Files:** modify `messaging.ts`; extend `messaging.test.ts`.

- [ ] **Test:**

```ts
import { forcePruneToMinimum } from "../src/gateway/messaging";
const SEED = "我先把 workspace 的 PKB context 給你 xxx";
describe("forcePruneToMinimum", () => {
  it("keeps seed pair + last pair, returns droppedPairs", () => {
    const session = {
      messages: [
        { role: "user" as const, content: SEED }, { role: "assistant" as const, content: "ok" },
        { role: "user" as const, content: "Q1" }, { role: "assistant" as const, content: "A1" },
        { role: "user" as const, content: "Q2" }, { role: "assistant" as const, content: "A2" },
        { role: "user" as const, content: "Q3" }, { role: "assistant" as const, content: "A3" },
      ],
      approxTokens: 0,
    };
    const dropped = forcePruneToMinimum(session);
    assert.equal(dropped, 2);
    assert.equal(session.messages.length, 4);
    assert.ok(session.messages[0].content.startsWith("我先把"));
    assert.equal(session.messages[3].content, "A3");
  });
  it("works without seed pair", () => {
    const session = {
      messages: [
        { role: "user" as const, content: "Q1" }, { role: "assistant" as const, content: "A1" },
        { role: "user" as const, content: "Q2" }, { role: "assistant" as const, content: "A2" },
      ],
      approxTokens: 0,
    };
    assert.equal(forcePruneToMinimum(session), 1);
    assert.equal(session.messages[0].content, "Q2");
  });
  it("idempotent on already-minimal sessions", () => {
    const session = {
      messages: [
        { role: "user" as const, content: SEED }, { role: "assistant" as const, content: "ok" },
        { role: "user" as const, content: "Q" }, { role: "assistant" as const, content: "A" },
      ],
      approxTokens: 0,
    };
    assert.equal(forcePruneToMinimum(session), 0);
    assert.equal(session.messages.length, 4);
  });
});
```

- [ ] **Impl** (append to `messaging.ts`):

```ts
/**
 * Last-resort prune for the msg_too_long retry path. Keeps PKB seed
 * pair (if present) plus the most-recent user/assistant pair, drops
 * everything between. Returns dropped (user,assistant) pair count.
 * Idempotent. Does not consult MAX_SESSION_TOKENS.
 */
export function forcePruneToMinimum(session: SessionLike): number {
  const msgs = session.messages;
  const hasPkbSeed =
    msgs.length >= 2 &&
    msgs[0].role === "user" &&
    msgs[0].content.startsWith(PKB_SEED_PREFIX) &&
    msgs[1].role === "assistant";
  const seedSlice = hasPkbSeed ? msgs.slice(0, 2) : [];
  const seedEnd = hasPkbSeed ? 2 : 0;
  if (msgs.length - seedEnd <= 2) return 0;
  const droppedPairs = Math.floor((msgs.length - seedEnd - 2) / 2);
  const tailSlice = msgs.slice(-2);
  session.messages = [...seedSlice, ...tailSlice];
  session.approxTokens = approxTokensFor(session.messages);
  return droppedPairs;
}
```

- [ ] **Commit:**

```bash
git commit -am "feat(gateway): forcePruneToMinimum for msg_too_long retry path"
```

---

## Task 6: Add three event-type literals to `GatewayEvent` union

**Files:** modify `packages/cli/src/gateway/events.ts`; extend `gateway-events.test.ts`.

- [ ] **Test** (append to gateway-events.test.ts — verifies round-trip via append/read):

```ts
import { appendGatewayEvent, readGatewayEvents } from "../src/gateway/events";
it("round-trips context.exceeded / context.force-pruned / message.capped", () => {
  appendGatewayEvent({ type: "context.exceeded", actor: "Uabc", sessionTokensBefore: 31578, retrievalAtoms: 1, phase: "first-call" });
  appendGatewayEvent({ type: "context.force-pruned", actor: "Uabc", droppedPairs: 4, tokensAfter: 1200 });
  appendGatewayEvent({ type: "message.capped", actor: "Uabc", kind: "seed", originalChars: 88292, cappedChars: 12000 });
  const events = readGatewayEvents({});
  const types = events.map((e) => e.type);
  assert.ok(types.includes("context.exceeded"));
  assert.ok(types.includes("context.force-pruned"));
  assert.ok(types.includes("message.capped"));
});
```

- [ ] **Impl** in `events.ts`. Add three interfaces (next to existing event interfaces):

```ts
export interface ContextExceededEvent {
  type: "context.exceeded";
  actor: string;
  sessionTokensBefore: number;
  retrievalAtoms: number;
  phase: "first-call" | "synthesise";
}
export interface ContextForcePrunedEvent {
  type: "context.force-pruned";
  actor: string;
  droppedPairs: number;
  tokensAfter: number;
}
export interface MessageCappedEvent {
  type: "message.capped";
  actor: string;
  kind: "seed" | "mra-result";
  originalChars: number;
  cappedChars: number;
}
```

Extend the `GatewayEvent` union (line 108):

```ts
export type GatewayEvent =
  | MraAskEndEvent
  | TurnProcessedEvent
  | EscalateTriggeredEvent
  | EscalateAbsorbedEvent
  | GatewayPresenceEvent
  | ContextExceededEvent
  | ContextForcePrunedEvent
  | MessageCappedEvent;
```

Extend `VALID_TYPES` (line 118):

```ts
const VALID_TYPES: ReadonlySet<string> = new Set([
  "mra-ask.end", "turn.processed", "escalate.triggered", "escalate.absorbed",
  "gateway.online", "gateway.offline",
  "context.exceeded", "context.force-pruned", "message.capped",
]);
```

- [ ] **Commit:**

```bash
git commit -am "feat(gateway): add context.exceeded / context.force-pruned / message.capped events"
```

---

## Task 7: `PmkContextTooLongError` in `claude-agent.ts`

**Files:** modify `packages/cli/src/llm/claude-agent.ts`; create `packages/cli/test/llm-claude-agent.test.ts`.

- [ ] **Test** (new file):

```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { PmkContextTooLongError, isContextTooLongError } from "../src/llm/claude-agent";

describe("PmkContextTooLongError detection", () => {
  it("matches msg_too_long error message", () => {
    assert.equal(isContextTooLongError(new Error("An API error occurred: msg_too_long")), true);
  });
  it("matches 'prompt is too long'", () => {
    assert.equal(isContextTooLongError(new Error("prompt is too long for the model")), true);
  });
  it("matches 'context window exceeded'", () => {
    assert.equal(isContextTooLongError(new Error("context window exceeded")), true);
  });
  it("does not match unrelated errors", () => {
    assert.equal(isContextTooLongError(new Error("rate limit hit")), false);
  });
  it("preserves cause", () => {
    const cause = new Error("msg_too_long");
    const err = new PmkContextTooLongError(cause);
    assert.equal(err.cause, cause);
    assert.ok(err instanceof Error);
  });
});
```

- [ ] **Impl** in `claude-agent.ts`. Add at the top of the file (after imports):

```ts
export class PmkContextTooLongError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super("PmkContextTooLongError");
    this.name = "PmkContextTooLongError";
    this.cause = cause;
  }
}

const CONTEXT_TOO_LONG_RE = /msg_too_long|prompt is too long|context.+exceed/i;

export function isContextTooLongError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return CONTEXT_TOO_LONG_RE.test(err.message);
}
```

Wrap the body of `chat()` in try/catch to convert matching errors:

```ts
async chat(systemPrompt, messages, opts = {}) {
  try {
    // … existing body unchanged …
    return full;
  } catch (err) {
    if (isContextTooLongError(err)) throw new PmkContextTooLongError(err);
    throw err;
  }
}
```

- [ ] **Commit:**

```bash
git add packages/cli/src/llm/claude-agent.ts packages/cli/test/llm-claude-agent.test.ts
git commit -m "feat(llm): typed PmkContextTooLongError on msg_too_long-shaped errors"
```

---

## Task 8: Apply seed cap in `runFreeChatTurn`

**Files:** modify `slack/index.ts`; extend `gateway.test.ts`.

- [ ] **Test** (extend gateway.test.ts) — sketch: drive `runFreeChatTurn` (or its testable extracted seed path) with `defaultIngest` returning a 50_000-char seed, assert that `session.messages[0].content.length <= SEED_CAP` and that a `message.capped` event with `kind:"seed"` was appended.

Use the project's existing fake-LLM / fake-Slack harness. If gateway.test.ts already mocks WebClient and provider, follow that pattern; otherwise extract the seed-application block into a helper called `applySeed(session, ingestSpec, mraWorkspace, actor)` and unit-test that helper directly.

- [ ] **Impl in `slack/index.ts`** at the seed write site (~line 497–509). Replace:

```ts
if (session.messages.length === 0 && this.config.defaultIngest) {
  const seed = buildIngestSeed(this.config.defaultIngest, this.config.mraWorkspace);
  if (seed) {
    session.messages.push({ role: "user", content: seed });
    session.messages.push({ role: "assistant", content: "了解，已載入 workspace PKB context。請繼續。" });
  }
}
```

With:

```ts
if (session.messages.length === 0 && this.config.defaultIngest) {
  const seedRaw = buildIngestSeed(this.config.defaultIngest, this.config.mraWorkspace);
  if (seedRaw) {
    const cap = capMessageContent(seedRaw, SEED_CAP);
    if (cap.capped) {
      appendGatewayEvent({
        type: "message.capped",
        actor: userId,
        kind: "seed",
        originalChars: cap.originalChars,
        cappedChars: cap.content.length,
      });
    }
    session.messages.push({ role: "user", content: cap.content });
    session.messages.push({ role: "assistant", content: "了解，已載入 workspace PKB context。請繼續。" });
  }
}
```

Update imports from `../messaging` to include `capMessageContent` and `SEED_CAP`.

- [ ] **Commit:**

```bash
git commit -am "feat(gateway): cap PKB seed at SEED_CAP chars, emit message.capped audit event"
```

---

## Task 9: Apply mra-result cap; remove hardcoded 24_000 in `buildMraSuccessMessage`

**Files:** modify `messaging.ts` and `slack/index.ts`; extend `gateway.test.ts`.

- [ ] **Test** (extend gateway.test.ts): drive `synthesiseAfterMra` (via `handleMraAskRound` happy path with a 30_000-char fake stdout). Assert: pushed `mra-result` user message length ≤ MRA_RESULT_CAP + truncate-marker overhead; a `message.capped` event with `kind:"mra-result"` was appended.

- [ ] **Impl in `messaging.ts`:** change `buildMraSuccessMessage` (line 116-124) to accept already-capped stdout — remove the inner `truncate(stdout.trim(), 24_000)`:

```ts
export function buildMraSuccessMessage(repo: string, stdout: string): string {
  return [
    `這是 \`mra ask ${repo}\` 的回傳結果（請依此 synthesise 最終答案；若這份結果不足，可再 emit 一次 mra-ask，但仍以 PKB + 這份結果優先）：`,
    "",
    "```mra-result",
    stdout.trim(),
    "```",
  ].join("\n");
}
```

- [ ] **Impl in `slack/index.ts`** at the mra-success branch inside `handleMraAskRound` / `synthesiseAfterMra` (around line 1108-1111). Replace:

```ts
const mraMessage = result.ok
  ? buildMraSuccessMessage(request.repo, result.stdout)
  : buildMraFailureMessage(request.repo, result);
session.messages.push({ role: "user", content: mraMessage });
```

With:

```ts
let mraMessage: string;
if (result.ok) {
  const cap = capMessageContent(result.stdout, MRA_RESULT_CAP);
  if (cap.capped) {
    appendGatewayEvent({
      type: "message.capped",
      actor: args.actor,
      kind: "mra-result",
      originalChars: cap.originalChars,
      cappedChars: cap.content.length,
    });
  }
  mraMessage = buildMraSuccessMessage(request.repo, cap.content);
} else {
  mraMessage = buildMraFailureMessage(request.repo, result);
}
session.messages.push({ role: "user", content: mraMessage });
```

Thread `actor: userId` into `synthesiseAfterMra`'s args interface (and into the call site at line 561 in `handleMraAskRound`). Update `synthesiseAfterMra`'s typed `args:` block to add `actor: string;`.

Update `slack/index.ts` imports from `../messaging` to include `MRA_RESULT_CAP`.

- [ ] **Commit:**

```bash
git commit -am "feat(gateway): cap mra-result at MRA_RESULT_CAP chars, emit message.capped event"
```

---

## Task 10: Reorder prune to BEFORE the LLM call in `runFreeChatTurn`

**Files:** modify `slack/index.ts`; extend `gateway.test.ts`.

- [ ] **Test** (extend gateway.test.ts): inject a spy provider whose `chat` records a flag `pruneCalledBefore = (session.messages was already pruned)`. Set up a session whose `approxTokens > MAX_SESSION_TOKENS` before the turn. Assert: by the time `provider.chat` runs, `session.messages.length` reflects the pruned state.

- [ ] **Impl** in `runFreeChatTurn` (`slack/index.ts:485-605`). Move the prune block to **before** `this.llm.chat(...)`:

```ts
// (after retrievalPrefix is computed and before placeholder is posted)
const pruneReport = pruneSessionIfNeeded(session, {
  extra: retrievalPrefix,
  newUser: text,
});
if (pruneReport.pruned) {
  this.onLog(`pruned session: dropped ${pruneReport.droppedPairs} pair(s); now ${pruneReport.tokensAfter} tokens`);
}
session.messages.push({ role: "user", content: text });
session.turns += 1;

// … placeholder.postMessage … pickAudience … pickGatewayPrompt …

// LLM call (unchanged)
let full = "";
try {
  full = await this.llm.chat(systemPrompt, [
    ...retrievalPrefix,
    ...session.messages,
  ], { onToken: () => {} });
} catch (err) { /* T11 retry path lands here */ }
```

Delete the old post-call prune block at line 598-603 (replaced by pre-call prune).

The post-LLM `session.approxTokens = approxTokensFor(session.messages)` recompute (line 592) stays — it's just the snapshot for storage.

- [ ] **Commit:**

```bash
git commit -am "fix(gateway): prune session BEFORE LLM call (closes msg_too_long fail-loop)"
```

---

## Task 11: Retry path on `PmkContextTooLongError` (first call)

**Files:** modify `slack/index.ts`; extend `gateway.test.ts`.

- [ ] **Test** (extend gateway.test.ts): provider whose first `chat()` throws `new PmkContextTooLongError(...)`, second `chat()` returns "ok". Assert:
  - Final Slack message body starts with `:scissors: 對話過長，已自動裁掉`
  - `context.exceeded` event written with `phase: "first-call"`
  - `context.force-pruned` event written
  - `session.messages` after the turn has 4 (or 6 if seed) entries

Second test: both calls throw `PmkContextTooLongError`. Assert: Slack `chat.update` called with `:x: 對話太長，請開新 thread 重新提問`; no assistant message appended to session.

- [ ] **Impl in `runFreeChatTurn`:** wrap the LLM call:

```ts
import { PmkContextTooLongError } from "../../llm/claude-agent";

// …
let full = "";
let scissorsPrefix = "";
try {
  full = await this.llm.chat(systemPrompt, [
    ...retrievalPrefix, ...session.messages,
  ], { onToken: () => {} });
} catch (err) {
  if (!(err instanceof PmkContextTooLongError)) {
    await this.web.chat.update({
      channel: channelId, ts: String(placeholder.ts),
      text: `:warning: ${(err as Error).message}`,
    });
    return;
  }
  appendGatewayEvent({
    type: "context.exceeded",
    actor: userId,
    sessionTokensBefore: session.approxTokens,
    retrievalAtoms: retrieved.length,
    phase: "first-call",
  });
  const dropped = forcePruneToMinimum(session);
  appendGatewayEvent({
    type: "context.force-pruned",
    actor: userId,
    droppedPairs: dropped,
    tokensAfter: session.approxTokens,
  });
  try {
    full = await this.llm.chat(systemPrompt, [
      ...retrievalPrefix, ...session.messages,
    ], { onToken: () => {} });
    scissorsPrefix = `:scissors: 對話過長，已自動裁掉 ${dropped} 輪舊訊息\n\n`;
  } catch (err2) {
    await this.web.chat.update({
      channel: channelId, ts: String(placeholder.ts),
      text: ":x: 對話太長，請開新 thread 重新提問",
    });
    return;
  }
}
```

When prepending `visible` to the final Slack message at line 614+, prepend `scissorsPrefix` first.

Add `forcePruneToMinimum` to imports from `../messaging`.

- [ ] **Commit:**

```bash
git commit -am "feat(gateway): auto-retry on msg_too_long with force-prune + scissors marker"
```

---

## Task 12: Same retry wrapper around `synthesiseAfterMra`

**Files:** modify `slack/index.ts`; extend `gateway.test.ts`.

- [ ] **Test:** mra-ask happy path → first synthesis call throws `PmkContextTooLongError`, second succeeds. Assert `phase: "synthesise"` event recorded and scissors prefix shown.

- [ ] **Impl:** in `synthesiseAfterMra` (line 1091-1120), wrap the `this.llm.chat(...)` call with the same try/catch shape from Task 11. Set `phase: "synthesise"`. Return `{ full, scissorsPrefix }` instead of just `full`, and have the caller in `handleMraAskRound` prepend `scissorsPrefix` when posting the final message.

To DRY: extract the retry wrapper into a private method:

```ts
private async chatWithContextRetry(args: {
  systemPrompt: string;
  messages: ChatMessage[];
  session: FreeChatSession;
  actor: string;
  retrievalAtoms: number;
  phase: "first-call" | "synthesise";
}): Promise<{ ok: true; full: string; scissorsPrefix: string } | { ok: false }>
```

Use it from both `runFreeChatTurn` (T11) and `synthesiseAfterMra`. T11 task may opt to land the inline version first and refactor here — both are acceptable; pick one and stay consistent.

- [ ] **Commit:**

```bash
git commit -am "feat(gateway): apply context-retry wrapper to synthesiseAfterMra (mra-ask round)"
```

---

## Task 13: Add `Context safety` aggregation in `audit.ts`

**Files:** modify `audit.ts`; extend `gateway-audit.test.ts`.

- [ ] **Test:** seed events log with: 2× `context.exceeded` (1 first-call, 1 synthesise), 2× `context.force-pruned`, 3× `message.capped` (2 seed, 1 mra-result). Run `buildAuditReport({ days: 30 })`. Assert `report.contextSafety` equals:

```ts
{
  contextExceeded: { total: 2, firstCall: 1, synthesise: 1 },
  contextForcePruned: 2,
  messageCapped: { total: 3, seed: 2, mraResult: 1 },
}
```

- [ ] **Impl in `audit.ts`:** extend `AuditReport` interface (line 25-66) with:

```ts
contextSafety: {
  contextExceeded: { total: number; firstCall: number; synthesise: number };
  contextForcePruned: number;
  messageCapped: { total: number; seed: number; mraResult: number };
};
```

In `buildAuditReport`, add counters before the for-loop:

```ts
let ctxExc = 0, ctxExcFirst = 0, ctxExcSynth = 0;
let ctxForcePruned = 0;
let msgCap = 0, msgCapSeed = 0, msgCapMra = 0;
```

Add cases inside the existing `switch (e.type)`:

```ts
case "context.exceeded":
  ctxExc++;
  if (e.phase === "first-call") ctxExcFirst++;
  else if (e.phase === "synthesise") ctxExcSynth++;
  break;
case "context.force-pruned":
  ctxForcePruned++;
  break;
case "message.capped":
  msgCap++;
  if (e.kind === "seed") msgCapSeed++;
  else if (e.kind === "mra-result") msgCapMra++;
  break;
```

Add to the returned object:

```ts
contextSafety: {
  contextExceeded: { total: ctxExc, firstCall: ctxExcFirst, synthesise: ctxExcSynth },
  contextForcePruned: ctxForcePruned,
  messageCapped: { total: msgCap, seed: msgCapSeed, mraResult: msgCapMra },
},
```

- [ ] **Commit:**

```bash
git commit -am "feat(gateway): aggregate context.* + message.capped events into AuditReport"
```

---

## Task 14: Render `Context safety` in `audit-format.ts`

**Files:** modify `audit-format.ts`; extend `gateway-audit-format.test.ts`.

- [ ] **Test:** call `formatAuditReport(report)` with a synthetic report whose `contextSafety` totals are non-zero. Assert output contains:
  - `Context safety` (chalk.bold header)
  - `context.exceeded:` line with `2 (first-call 1, synthesise 1)`
  - `force-pruned:` line with `2`
  - `messages capped:` line with `3 (seed 2, mra-result 1)`
- Also test the all-zero case: section either rendered with `0` rows or omitted (pick one and assert it).

Recommendation: always render the section so an operator sees the safety net is in place even when nothing fired.

- [ ] **Impl** in `audit-format.ts` (insert before the `// flags` block, ~line 96):

```ts
// context safety
lines.push("");
lines.push(chalk.bold("Context safety"));
const cs = report.contextSafety;
lines.push(
  label("context.exceeded:") +
    `${cs.contextExceeded.total} (first-call ${cs.contextExceeded.firstCall}, synthesise ${cs.contextExceeded.synthesise})`,
);
lines.push(label("force-pruned:") + cs.contextForcePruned);
lines.push(
  label("messages capped:") +
    `${cs.messageCapped.total} (seed ${cs.messageCapped.seed}, mra-result ${cs.messageCapped.mraResult})`,
);
```

- [ ] **Commit:**

```bash
git commit -am "feat(gateway): render Context safety section in pmk gateway audit"
```

---

## Task 15: Update `changelog.md` and `v0.11-migration.md`

**Files:** modify `apps/docs/docs/changelog.md`; modify `apps/docs/docs/gateway/v0.11-migration.md`.

- [ ] **Impl 1 — changelog:** add a new `## 0.11.1` heading above the existing `## 0.11.0` entry. Body:

```md
## 0.11.1 — 2026-05-DD

### Fixed
- gateway: `msg_too_long` no longer reaches end users. Three layered defenses: (a) prune now runs **before** the LLM call (closes a fail-loop introduced in v0.8.1); (b) PKB seed and `mra-ask` results are capped at write-time; (c) any residual `msg_too_long` triggers an automatic force-prune + retry path that prefixes the reply with `:scissors: 對話過長，已自動裁掉 N 輪舊訊息`. Hard failure shows a friendly `:x: 對話太長，請開新 thread 重新提問` rather than the raw API error.

### Changed
- `PMK_MAX_SESSION_TOKENS` default lowered 60_000 → 25_000 to leave headroom for SDK-inherited host context.

### Added
- New env vars `PMK_SEED_CAP` (default 12_000 chars) and `PMK_MRA_RESULT_CAP` (default 16_000 chars).
- New event types `context.exceeded`, `context.force-pruned`, `message.capped` in the events log.
- `pmk gateway audit` gains a `Context safety` section rolling up the new events.
```

- [ ] **Impl 2 — migration doc:** append at the bottom of `v0.11-migration.md`:

```md
## v0.11.1: context-safety hardening (additive)

No breaking changes. Operator-facing additions:

| Env var | Default | What it caps |
|---|---|---|
| `PMK_MAX_SESSION_TOKENS` | 25000 (was 60000) | Soft session-prune budget |
| `PMK_SEED_CAP` | 12000 | Chars in PKB ingest seed |
| `PMK_MRA_RESULT_CAP` | 16000 | Chars in any `mra-ask` stdout pushed into session history |

Three new event types appear in `~/.pmk/gateway/events-YYYY-MM.log`:
`context.exceeded`, `context.force-pruned`, `message.capped`.
`pmk gateway audit` reports them under the new `Context safety`
section. Tighten the `*_CAP` env vars if `context.exceeded` appears
in your weekly audit.
```

- [ ] **Commit:**

```bash
git add apps/docs/docs/changelog.md apps/docs/docs/gateway/v0.11-migration.md
git commit -m "docs: changelog + migration notes for v0.11.1 msg_too_long hardening"
```

---

## Task 16: Pre-tag verification + version bump + release

**Files:** run scripts; modify `package.json` files via existing bump script; tag.

- [ ] **Step 1: Restart gateway after T11/T12 land**

```bash
npm --workspace packages/cli run start -- gateway start
```

- [ ] **Step 2: Verify prune-before-call fires**

In the previously-bloated `#新頻道` thread `1778139665.927099` (already cleared on 2026-05-07; let it accumulate naturally), run several mra-ask rounds. Confirm: no `msg_too_long`. Tail events log:

```bash
tail -f ~/.pmk/gateway/events-2026-05.log
```

Expect to see at least one `message.capped` event for `kind:"seed"` on the first turn.

- [ ] **Step 3: Force a synthetic msg_too_long to exercise the retry path**

```bash
PMK_MAX_SESSION_TOKENS=1 npm --workspace packages/cli run start -- gateway start
```

(Restart with the env var.) Send any DM. Expect:
- Reply prefixed with `:scissors: 對話過長，已自動裁掉 …`
- `context.exceeded` + `context.force-pruned` events in the log

- [ ] **Step 4: Run audit**

```bash
npm --workspace packages/cli run start -- gateway audit --days 1
```

Confirm the new `Context safety` section renders with non-zero counters.

- [ ] **Step 5: Bump version**

```bash
npm run version:bump -- 0.11.1
```

(Existing `scripts/bump-version.mjs` writes `0.11.1` into `package.json`, all workspace packages, and any version constants.)

- [ ] **Step 6: Commit + tag + push**

```bash
git add package.json packages/*/package.json apps/*/package.json
git commit -m "chore(release): bump workspace versions to 0.11.1"
git tag v0.11.1
git push origin main
git push origin v0.11.1
```

(If using a feature branch + PR per `feedback_release_workflow.md`, push the branch first and squash-merge after review; tag from main after merge.)

---

## Self-review checklist

- [x] **Spec coverage** — every section of the spec maps to a task:
  - 1.1 Move prune → T10
  - 1.2 retrievalPrefix in budget → T3, T4
  - 1.3 capMessageContent → T1; applied at seed (T8) and mra-result (T9)
  - 1.4 MAX_SESSION_TOKENS lowered → T2
  - 2.1 PmkContextTooLongError → T7
  - 2.2 Force-prune + retry, both call sites → T11, T12
  - 3 Three event types → T6 (declare), T8/T9/T11/T12 (emit), T13/T14 (audit)
  - 4 Three env vars → T2
  - Components touched (table) → covered by T1-T15
  - Testing plan → covered as TDD inside each task; gateway-audit / gateway-audit-format tests in T13/T14
  - Release plan → T15 (changelog/migration), T16 (verify + bump + tag)
  - v0.12 forward-link → already in spec; no implementation step needed
- [x] **No placeholders** — all code blocks contain real code; commands are runnable; no `// TODO`, no "implement later".
- [x] **Type consistency** — `CapResult`, `PruneOpts`, `PmkContextTooLongError`, `ContextExceededEvent`, etc. are referenced consistently across tasks. Method names: `capMessageContent`, `forcePruneToMinimum`, `pruneSessionIfNeeded`, `approxTokensFor`, `isContextTooLongError`. Env-var names: `PMK_MAX_SESSION_TOKENS`, `PMK_SEED_CAP`, `PMK_MRA_RESULT_CAP`. Constants: `MAX_SESSION_TOKENS`, `SEED_CAP`, `MRA_RESULT_CAP`. Event-type strings: `context.exceeded`, `context.force-pruned`, `message.capped`.
