# Extract the review runner out of review.ts

**Date:** 2026-08-04
**Status:** Approved, pending implementation
**Touches:** `packages/cli/src/gateway/slack/review.ts` (910 lines), new `packages/cli/src/gateway/slack/review-runner.ts`
**Follows:** `2026-08-04-review-approve-flow-extraction-design.md`

## Problem

`review.ts` is 910 lines against the project's 800-line ceiling — over by 110. The previous
pass took it from 1,193 by moving the approve-authorisation cluster out; this closes the gap.

## Why not the cut the previous spec named

That spec's Known Gap said the next pass was the request-handling layer —
`processReviewRequest` (83) + `processApproveRequest` (114), ~200 lines. **That is the wrong
cut.**

Both methods *call* `runOne`. Extracting them leaves `runOne` behind, so the new module would
have to import a value back from `review.ts` — exactly the runtime import cycle the previous
pass had to unpick (`protectionNotReadyMessage` moved to a leaf module to break it). Doing the
same thing again knowingly would be worse than not moving anything.

Cut the other way instead.

## Approach

Move the **review runner**: the piece that executes one review, tracks it while in flight, and
drains it on shutdown.

| Lines | Member | Role |
|---|---|---|
| 289 | `runOne` | the acquire → work → release execution scope |
| 26 | `drainOnShutdown` | aborts + releases every in-flight review at shutdown |
| 6 | `backoff` | the retry wait, abortable by the drain |
| 11 | `replyWithTs` | posts the progress-bar anchor message |
| — | `inFlight` field, `InFlightReview` type | the shared state all of the above turn on |
| **332** | | |

`review.ts` 910 → **~598**.

### Why this is a real boundary, not line-shuffling

These four are one responsibility, and they are the *only* members that touch `inFlight`:
`runOne` adds and removes, `drainOnShutdown` empties it, `backoff` observes the abort signal
that `drainOnShutdown` raises. Moving them together takes the shared state with them instead of
leaving it spread across a coordinator that no longer uses it.

What remains in `review.ts` is then a single coherent job: **translate Slack events into review
requests, and dispatch them.**

### This does not contradict "extract decisions, not scopes"

The earlier ruling was against *splitting* `runOne`'s acquire → work → release bracket, because
its correctness protocol ("every early exit passes through the `finally`, which reads `posted`
to decide whether the claim survives") is only locally verifiable while it sits in one function.

Moving the whole bracket into its own file does the opposite of splitting it: the scope stays
intact, and the state it owns moves with it. Nothing about the protocol becomes a cross-module
invariant.

## Design

### The unit

`packages/cli/src/gateway/slack/review-runner.ts`, exporting class `ReviewRunner`.

**Does:** run one PR review or approve-prereview to completion — claim, workspace clone,
progress bar, mra invocation, GitHub post, audit, cleanup — and hold the in-flight registry
that shutdown drains.

**Does not:** parse Slack events, decide *whether* to review, or authorise approvals.

`ReviewCoordinator` keeps `drainOnShutdown` as a one-line delegation, because `slack/index.ts`
calls it at two places during shutdown. Its public surface does not change.

### The seam

```ts
export interface ReviewRunnerDeps {
  gateway: ReviewGateway;
  web: WebClient;
  onLog: (m: string) => void;
  /** Injectable sleep for the retry backoff; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  currentConfig: () => GatewayConfig;
  reply: (ch: string, threadTs: string, text: string) => Promise<void>;
}
```

**`currentConfig` must stay a thunk**, for the same reason as `ApproveFlow`: `runOne` re-reads
live config at post time (`postProtocolV1Review` re-validates policy before the GitHub POST).
A snapshot would let a revoked policy through. The correct wiring is
`currentConfig: () => this.currentConfig()`.

Note the two forms that break it, both measured on the previous extraction:
`currentConfig: this.currentConfig()` fails to compile (TS2322);
`currentConfig: this.currentConfig` compiles but loses `this` and fails the coordinator suite
loudly. Neither is silent — but wire it correctly rather than relying on that.

### Behaviour

**Pure refactor. Every user-facing string stays byte-identical.** Moved code changes only by
`this.X` → `this.deps.X` and by the internal calls (`this.backoff`, `this.replyWithTs`) becoming
intra-class.

### Error handling

Unchanged by construction — nothing inside the moved code is edited. The `skip(...)` +
`finally` protocol, the `posted` flag deciding claim release, and the abort wiring all move
together and keep their existing relationships.

### Testing

No new tests. The existing suite — `review-coordinator.test.ts` alone has 102 assertions, most
of which drive `runOne` end to end — must pass **unchanged**. That is the equivalence proof.

Direct `ReviewRunner` tests are worth adding afterwards, separately, for the same reason the
`ApproveFlow` fence tests were: to hold properties the coordinator-level tests cannot see.

## Scope

**In:** the four members, the `inFlight` field and `InFlightReview` type, the deps interface,
the `drainOnShutdown` delegation.

**Out:** the request-handling layer, message changes, new tests, the other oversized files
(`slack/index.ts` 1,149, `adapters/mra.ts` 1,038, `config.ts` 817).

## Result

`review.ts` lands at ~598, **under the 800 ceiling** — the first of the four oversized files to
clear it. The remaining three are untouched and unplanned here.
