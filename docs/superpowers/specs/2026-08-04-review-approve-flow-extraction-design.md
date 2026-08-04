# Extract the approve-authorisation flow out of review.ts

**Date:** 2026-08-04
**Status:** Approved, pending implementation
**Touches:** `packages/cli/src/gateway/slack/review.ts` (1,193 lines), new `packages/cli/src/gateway/slack/review-approve-flow.ts`
**Follows:** `2026-07-17-approve-protection-exemption-design.md`, `2026-07-20-approve-ungated-repos-design.md`

## Problem

Four source files exceed the project's 800-line ceiling:

```
1193  gateway/slack/review.ts
1149  gateway/slack/index.ts
1038  adapters/mra.ts
 817  gateway/config.ts
```

`review.ts` was the obvious first target, and the obvious move looked like finishing the
`runOne` decomposition started in v0.40.0 (phases A and B, `review-target.ts` and
`review-admission.ts`). **That reasoning was wrong**, for two separate reasons.

### Shrinking runOne does not fix the file

`review.ts` holds several large coordinator methods:

| Lines | Method |
|---|---|
| 289 | `runOne` |
| 132 | `publishApprovalReservation` |
| 114 | `processApproveRequest` |
| 83 | `processReviewRequest` |
| 72 | `confirmApproveInThread` |
| 61 | `currentConfig` |
| 33 | `mismatchedConfirmationPr` |
| 23 | `missingOfferMessage` |

Taking `runOne` from 289 to the 50-line guideline removes 239 lines and leaves the file at
~954 — still over. The file is oversized because it holds **two responsibilities**, not because
one function is long.

### What remains of runOne is a resource scope, not a pipeline

Phases A and B were extractable because each was a *decision* over inputs, holding no state.
What remains is not:

| State | Created | Used | Released |
|---|---|---|---|
| `claimRef` | phase B | `finalizeReview` | `finally` → `releaseReview` |
| `inflight` / `controller` | phase C | mra `signal` | `finally` → `inFlight.delete` |
| `progress` | phase C | the `skip` closure, `onLine`, `finish` | `finally` → `dispose` |
| `posted` | phase C | set on success | `finally` → decides claim release |
| review clone | phase C | mra | `finally` → `teardownReviewClone` |

This is an acquire → work → release bracket. Its correctness protocol is stated in the code
(review.ts:1099): *"route through skip so the finally releases the claim"* — every early exit
relies on `finally` reading `posted` to decide whether the claim survives as an idempotency
record or is released for retry.

Splitting that across functions converts five pieces of closure state into a parameter list, and
converts a locally-verifiable guarantee ("every exit path passes through this `finally`") into an
invariant that must hold across module boundaries. A future early-return added inside an
extracted function would break claim release with no test to catch it.

**Decision: stop decomposing `runOne`.** Extract decisions, not scopes.

## Approach

Extract the approve-authorisation cluster instead. Four methods, **contiguous** at
review.ts:543–802 — already a de-facto module with no boundary drawn:

| Lines | Method |
|---|---|
| 72 | `confirmApproveInThread` (public entry) |
| 33 | `mismatchedConfirmationPr` |
| 23 | `missingOfferMessage` |
| 132 | `publishApprovalReservation` |
| **260** | **total** |

They share no mutable state with `runOne`. The two flows communicate only through the approval
offer on disk (`review-approval.ts`), which is already a durable, tested interface.

`review.ts` 1,193 → ~948.

## Design

### The unit

`packages/cli/src/gateway/slack/review-approve-flow.ts`, exporting class `ApproveFlow`.

**Does:** turns an admin's in-thread `approve` into a real GitHub APPROVE or an honest refusal —
authorisation checks, pending reconciliation, offer reservation, and the preflight → POST
critical section under the authorization lock.

**Does not:** run reviews, touch review claims, or participate in `runOne`'s resource scope.

`ReviewCoordinator.confirmApproveInThread` becomes a one-line delegation. **The public API does
not change**, so `slack/index.ts` and its callers are untouched.

### The seam

The cluster's four external `this` dependencies become an explicit interface:

```ts
export interface ApproveFlowDeps {
  gateway: ReviewGateway;
  onLog: (m: string) => void;
  currentConfig: () => GatewayConfig;
  fetchMessageText: (ch: string, ts: string) => Promise<string | undefined>;
  reply: (ch: string, threadTs: string, text: string) => Promise<void>;
}
```

**`currentConfig` must stay a function, not a snapshot.** `publishApprovalReservation` runs three
revision fences that each re-read live config to detect a concurrent policy change mid-approve.
Passing a value would silently disable all three — they would compare a snapshot against itself
and always pass. This is the single most dangerous mistake available in this extraction.

Secondary benefit: exercising the approve flow currently requires constructing a full
`ReviewCoordinator`. With this interface it needs five fakes.

### Behaviour

**Pure refactor. Every message stays byte-identical.**

The previous slice (phase B, v0.40.0) bundled a message improvement into a refactor. An existing
test asserted the old wording and failed, costing a debugging round. Not repeated here: any
message change is a separate PR.

Moved code changes only in that `this.x` becomes `this.deps.x`.

### Error handling

Unchanged. The cluster's existing contract is preserved exactly:

- `AuthorizationLockBusyError` and `GatewayConfigConflictError` continue to propagate to
  `handleAdminSlash`, which renders them as operator-facing text
- `markApprovalPendingReconcile` still runs when a POST outcome is unknown, leaving evidence on
  disk rather than guessing
- refusals still return without consuming the offer, so the admin can retry

### Testing

- the 25 existing approve-flow assertions in `review-coordinator.test.ts` **pass unchanged** —
  the public API is untouched, which is the strongest available equivalence proof
- `git diff` on the moved block shows only `this.x` → `this.deps.x`
- full suite green (1,267 at time of writing: cli 1145, core 50, llm 13, rag 13, shared 32,
  desktop 14 — counted per workspace rather than carried forward, after the v0.40.0 commit
  message quoted a stale 1,257)

No new tests in this PR. Adding them would mix "did the move preserve behaviour" with "does new
coverage pass", and the first question is the one that matters here. Direct `ApproveFlow` tests
against the new seam are worth adding afterwards, separately.

## Scope

**In:** the four-method cluster, the deps interface, the delegation.

**Out:** `runOne` (see above), message changes, new tests, the other three oversized files.

## Known gap

After this change `review.ts` is ~948 lines — **still over the 800 ceiling**. Reaching it needs
another pass over the request-handling layer (`processReviewRequest` / `processApproveRequest`,
~200 lines).

That pass is deliberately not planned here. The approve flow is the highest-risk code in this
system — it performs real, externally-visible GitHub mutations — and 260 lines is the most worth
moving in a single reviewable change. Verify this one first, then decide whether the remaining
gap justifies another.
