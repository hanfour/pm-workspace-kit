# Approve-Flow Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the 260-line approve-authorisation cluster out of `review.ts` into its own module, behaviour byte-identical.

**Architecture:** A new `ApproveFlow` class in `gateway/slack/review-approve-flow.ts` owns the four contiguous methods at `review.ts:543–802`. Their four external `this` dependencies become an explicit `ApproveFlowDeps` interface. `ReviewCoordinator` constructs one and delegates; its public API does not change, so no caller is touched.

**Tech Stack:** TypeScript (ESM, Node ≥20), `node:test` + `tsx`, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-04-review-approve-flow-extraction-design.md`

## Global Constraints

- **Pure refactor.** Every user-facing string stays byte-identical. No message improvements, no new behaviour, no drive-by fixes. A message change belongs in its own PR.
- **`currentConfig` is a FUNCTION, never a snapshot.** `publishApprovalReservation` runs three revision fences that each re-read live config to detect a concurrent policy change mid-approve. Passing a value makes every fence compare a snapshot against itself and always pass — silently, with no failing test.
- **No new tests in this plan.** The 25 existing approve-flow assertions in `review-coordinator.test.ts` must pass **unchanged**; that is the equivalence proof. Direct `ApproveFlow` tests are separate follow-up work.
- **Moved code changes only by `this.X` → `this.deps.X`.** Nothing else.
- Run tests from the repo root: `npm test --workspace=packages/cli`.
- Test counts, when quoted, are summed per workspace — never carried forward from a previous run.

---

### Task 1: Move the approve POST critical section

Extracts the highest-risk 132 lines first, so a reviewer can gate it alone. `ReviewCoordinator.confirmApproveInThread` stays put and calls into the new class.

**Files:**
- Create: `packages/cli/src/gateway/slack/review-approve-flow.ts`
- Modify: `packages/cli/src/gateway/slack/review.ts` (remove 671–802; add construction + one call site)
- Test: `packages/cli/test/review-coordinator.test.ts` (unchanged — used as the equivalence proof)

**Interfaces:**
- Consumes: `ReviewGateway` and `GatewayConfig` (already exported from `./review` and `../config`); the module-level helpers `withAuthorizationLock`, `consumeApprovalReservation`, `markApprovalPendingReconcile`, `resolveApprovalReconciliation`, `appendGatewayEvent`, `resolveReviewConfig`, `isAdmin`, `resolveReviewGhToken`, `resolveGithubToken`, `findProtectionExemption`, `protectionNotReadyMessage`, `AUTOMATIC_APPROVAL_RELEASE_READY`, plus the type `ApprovalReservation`.
- Produces:
  ```ts
  export interface ApproveFlowDeps {
    gateway: ReviewGateway;
    currentConfig: () => GatewayConfig;
    fetchMessageText: (ch: string, ts: string) => Promise<string | undefined>;
    reply: (ch: string, threadTs: string, text: string) => Promise<void>;
  }
  export class ApproveFlow {
    constructor(deps: ApproveFlowDeps);
    publishReservation(reservation: ApprovalReservation, actorUserId: string): Promise<void>;
  }
  ```

- [ ] **Step 1: Record the baseline**

```bash
npm test --workspace=packages/cli 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

Expected: `tests 1145`, `pass 1145`, `fail 0`. Write the number down — Step 7 must match it exactly.

- [ ] **Step 2: Create the module with the deps interface and an empty class**

`packages/cli/src/gateway/slack/review-approve-flow.ts`:

```ts
/**
 * The approve-authorisation flow: turning an admin's in-thread `approve` into
 * a real GitHub APPROVE, or an honest refusal.
 *
 * Extracted from ReviewCoordinator, where it sat contiguously at
 * review.ts:543-802 sharing no mutable state with the review path — the two
 * communicate only through the approval offer on disk.
 */
import type { GatewayConfig } from "../config";
import type { ApprovalReservation } from "../review-approval";
import type { ReviewGateway } from "./review";

export interface ApproveFlowDeps {
  gateway: ReviewGateway;
  /**
   * MUST stay a function. publishReservation's three revision fences re-read
   * live config to detect a policy change landing mid-approve; a snapshot
   * would make each fence compare a value against itself and always pass.
   */
  currentConfig: () => GatewayConfig;
  fetchMessageText: (ch: string, ts: string) => Promise<string | undefined>;
  reply: (ch: string, threadTs: string, text: string) => Promise<void>;
}

export class ApproveFlow {
  constructor(private readonly deps: ApproveFlowDeps) {}
}
```

- [ ] **Step 3: Move `publishApprovalReservation` verbatim**

Cut `review.ts` lines 671–802 (the whole `private async publishApprovalReservation(...)` method) and paste it into `ApproveFlow`, renamed to `publishReservation` and made public.

Apply exactly these substitutions inside the moved body, and no others:

| From | To |
|---|---|
| `const { gateway } = this.opts;` | `const { gateway } = this.deps;` |
| `this.currentConfig()` | `this.deps.currentConfig()` |
| `this.reply(` | `this.deps.reply(` |

Move the imports the method needs from `review.ts` into the new file (see the Consumes list above). Leave them in `review.ts` too if other methods still use them — Step 6 removes the now-unused ones.

- [ ] **Step 4: Wire it into ReviewCoordinator**

In `review.ts`, add a field initialised in the constructor, after the existing `this.opts` assignment:

```ts
private readonly approveFlow = new ApproveFlow({
  gateway: this.opts.gateway,
  currentConfig: () => this.currentConfig(),
  fetchMessageText: (ch, ts) => this.fetchMessageText(ch, ts),
  reply: (ch, ts, text) => this.reply(ch, ts, text),
});
```

Note the arrow wrappers: they preserve `this` binding AND keep `currentConfig` lazy. Do not write `currentConfig: this.currentConfig` (loses `this`) or `currentConfig: this.currentConfig()` (evaluates once — breaks the fences).

Replace the old call site at line 603:

```ts
await this.publishApprovalReservation(reservation, args.userId);
```

with:

```ts
await this.approveFlow.publishReservation(reservation, args.userId);
```

Add the import: `import { ApproveFlow } from "./review-approve-flow";`

- [ ] **Step 5: Run the suite**

```bash
npm test --workspace=packages/cli 2>&1 | grep -E "error TS|^ℹ (tests|pass|fail)|✖ failing"
```

Expected: same counts as Step 1, `fail 0`, no `error TS`. Any failure here means the move was not verbatim — do not "fix" a test; re-diff the moved block.

- [ ] **Step 6: Remove imports left unused in review.ts**

```bash
npx tsc -p tsconfig.json --noEmit
```

TypeScript reports unused imports only if `noUnusedLocals` is on; if it is not, check by hand which of the Consumes-list symbols no longer appear in `review.ts` and delete those import entries. Re-run Step 5 after.

- [ ] **Step 7: Verify the diff is a pure move**

```bash
git diff --stat
git diff packages/cli/src/gateway/slack/review.ts | grep "^-" | grep -v "^---" | wc -l
```

Expected: `review.ts` loses ~132 lines; the new file is ~140. Read the removed block against the added one and confirm the ONLY differences are the three substitutions from Step 3.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/gateway/slack/review-approve-flow.ts packages/cli/src/gateway/slack/review.ts
git commit -m "refactor(gateway): move the approve POST critical section into ApproveFlow

Verbatim move of publishApprovalReservation (132 lines) behind an explicit
four-member deps interface. currentConfig stays a function so the three
revision fences keep re-reading live config.

Existing approve-flow tests pass unchanged, which is the equivalence proof."
```

---

### Task 2: Move the entry point and its message helpers

Moves the remaining 128 lines so the cluster is whole and `ReviewCoordinator` holds a one-line delegation.

**Files:**
- Modify: `packages/cli/src/gateway/slack/review-approve-flow.ts` (add three methods)
- Modify: `packages/cli/src/gateway/slack/review.ts` (remove 543–670; leave a delegation)
- Test: `packages/cli/test/review-coordinator.test.ts` (unchanged)

**Interfaces:**
- Consumes: `ApproveFlow` and `ApproveFlowDeps` from Task 1; additionally `reserveApprovalOffer`, `listPendingApprovalReconciliations`, `parsePrRefs`, `readGatewayEvents`, and the type `PrRef`.
- Produces:
  ```ts
  // on ApproveFlow
  confirmInThread(args: {
    channelId: string;
    threadTs: string;
    userId: string;
    text?: string;
  }): Promise<void>;
  ```
  `ReviewCoordinator.confirmApproveInThread` keeps its existing signature and delegates to this.

- [ ] **Step 1: Move the three methods verbatim**

Cut `review.ts` lines 543–670 — `confirmApproveInThread`, `mismatchedConfirmationPr`, `missingOfferMessage` — into `ApproveFlow`.

Rename only the entry point: `confirmApproveInThread` → `confirmInThread` (public). The other two stay `private` with their names unchanged.

Substitutions inside the moved bodies, and no others:

| From | To |
|---|---|
| `this.currentConfig()` | `this.deps.currentConfig()` |
| `this.reply(` | `this.deps.reply(` |
| `this.fetchMessageText(` | `this.deps.fetchMessageText(` |
| `this.opts.gateway` | `this.deps.gateway` |
| `this.mismatchedConfirmationPr(` | `this.mismatchedConfirmationPr(` *(unchanged — now an internal call)* |
| `this.missingOfferMessage(` | `this.missingOfferMessage(` *(unchanged)* |
| `this.publishApprovalReservation(` | `this.publishReservation(` |

- [ ] **Step 2: Leave the delegation in ReviewCoordinator**

Where the method used to be, put:

```ts
  /**
   * `approve` posted in a `:cr:` review thread → explicit authorization to run
   * the approve path for the same PR. Implemented in ApproveFlow; kept here so
   * the coordinator's public surface (and slack/index.ts) is unchanged.
   */
  async confirmApproveInThread(args: {
    channelId: string;
    threadTs: string;
    userId: string;
    text?: string;
  }): Promise<void> {
    return this.approveFlow.confirmInThread(args);
  }
```

- [ ] **Step 3: Run the suite**

```bash
npm test --workspace=packages/cli 2>&1 | grep -E "error TS|^ℹ (tests|pass|fail)|✖ failing"
```

Expected: same counts as Task 1 Step 1, `fail 0`, no `error TS`.

- [ ] **Step 4: Remove imports left unused in review.ts, then re-run**

```bash
npx tsc -p tsconfig.json --noEmit
npm test --workspace=packages/cli 2>&1 | grep -E "error TS|^ℹ (tests|pass|fail)"
```

- [ ] **Step 5: Confirm the file-size result**

```bash
wc -l packages/cli/src/gateway/slack/review.ts packages/cli/src/gateway/slack/review-approve-flow.ts
```

Expected: `review.ts` ~948 (down from 1193), new module ~275. Note in the commit that ~948 is **still over the 800 ceiling** — the spec's Known Gap.

- [ ] **Step 6: Run every workspace**

```bash
for w in packages/cli packages/core packages/llm packages/rag packages/shared apps/desktop; do
  out=$(npm test --workspace=$w 2>&1)
  echo "$w exit=$? $(echo "$out" | grep -E '^ℹ (tests|pass|fail) ' | tr '\n' ' ')"
done
```

Expected: every workspace `fail 0`. Sum the per-workspace `tests` numbers for the commit message; do not carry a total forward from an earlier run.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/gateway/slack/review-approve-flow.ts packages/cli/src/gateway/slack/review.ts
git commit -m "refactor(gateway): move the approve entry point into ApproveFlow

Completes the cluster: confirmApproveInThread, mismatchedConfirmationPr and
missingOfferMessage join publishReservation. ReviewCoordinator keeps a
one-line delegation, so its public API and slack/index.ts are unchanged.

review.ts 1193 -> ~948. Still over the 800 ceiling; closing that needs a
further pass over the request-handling layer, deliberately not bundled here."
```

---

## Verification before opening the PR

- [ ] every workspace green, counts summed per workspace
- [ ] `review-coordinator.test.ts` **not modified** (`git diff main --stat` shows no test changes)
- [ ] no user-facing string altered: `git diff main -- packages/cli/src/gateway/slack/ | grep -E "^[-+].*[:：]" | grep -v "^[-+].*//"` shows only moved lines, no edited text
- [ ] `slack/index.ts` untouched

## Self-review notes

**Spec coverage:** the unit (Task 1+2), the seam (Task 1 Step 2), behaviour preservation (Global Constraints + Task 1 Step 7), error handling (unchanged by construction — nothing in the moved code is edited), testing (existing 25 assertions unchanged), known gap (Task 2 Step 5).

**Not covered by any task, by design:** direct `ApproveFlow` unit tests, and the remaining ~148 lines needed to reach the 800 ceiling. Both are named in the spec as follow-up.
