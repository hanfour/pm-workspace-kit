# Review Runner Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the 332-line review runner out of `review.ts` into its own module, behaviour byte-identical, taking the file under the 800-line ceiling.

**Architecture:** A new `ReviewRunner` class in `gateway/slack/review-runner.ts` owns `runOne`, `drainOnShutdown`, `backoff`, `replyWithTs`, the `inFlight` registry and the `InFlightReview` type. Its external `this` dependencies become an explicit `ReviewRunnerDeps` interface. `ReviewCoordinator` constructs one, calls `runner.runOne(...)` from its two request handlers, and keeps `drainOnShutdown` as a delegation so `slack/index.ts` is untouched.

**Tech Stack:** TypeScript (ESM, Node ≥20), `node:test` + `tsx`, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-04-review-runner-extraction-design.md`

## Global Constraints

- **Pure refactor.** Every user-facing string stays byte-identical. No message improvements, no new behaviour, no drive-by fixes.
- **`currentConfig` is wired as a THUNK:** `currentConfig: () => this.currentConfig()`. `runOne` re-reads live config at post time to re-validate policy before the GitHub POST. `currentConfig: this.currentConfig()` fails to compile (TS2322); `currentConfig: this.currentConfig` compiles but loses `this`.
- **Do NOT add or modify any test.** The existing suite passing unchanged is the equivalence proof. `review-coordinator.test.ts` alone has 102 assertions, most driving `runOne` end to end.
- **`ReviewCoordinator.drainOnShutdown` keeps its exact signature** — `slack/index.ts` calls it at two places during shutdown and must not change.
- **Moved code changes only by `this.X` → `this.deps.X`**, plus internal calls (`this.backoff`, `this.replyWithTs`, `this.inFlight`) staying `this.` because they become intra-class.
- Class field initializers cannot read a parameter property under `target: ES2022` (TS2729). Assign the runner in the constructor body, as `approveFlow` already is.
- Run tests from the repo root: `npm test --workspace=packages/cli` (~90s). Run it ONCE per step and wait; do not launch concurrent runs.
- Test counts are summed per workspace, never carried forward from a previous run.

---

### Task 1: Move the runner

**Files:**
- Create: `packages/cli/src/gateway/slack/review-runner.ts`
- Modify: `packages/cli/src/gateway/slack/review.ts`
- Test: `packages/cli/test/review-coordinator.test.ts` (unchanged — the equivalence proof)

**Interfaces:**
- Consumes, all already exported: `ReviewGateway` (from `./review`, use `import type`), `GatewayConfig` (`../config`), `WebClient` (`@slack/web-api`), `PrRef` (`../pr-ref`), `ReviewRef` (`../review-claim`), `resolveReviewConfig` (`../config`), and the module-level helpers `claimReview`, `forceClaimReview`, `finalizeReview`, `releaseReview`, `saveApprovalOffer`, `appendGatewayEvent`, `resolveReviewTarget`, `admissionRefusal`, `admissionRefusalMessage`, `ReviewProgress`, `buildReviewMraArgs`, `runMraReviewWithRetry`, `postProtocolV1Review`, `canConfirmApproveFromReview`, `reviewResultText`, `approveResultText`, `describeMraFailure`, `effectiveMraReviewStrategy`, `findProtectionExemption`.
  This list is indicative, not authoritative — the equivalent list was wrong twice on the previous extraction. Import what the moved code actually references.
- Produces:
  ```ts
  export interface ReviewRunnerDeps {
    gateway: ReviewGateway;
    web: WebClient;
    onLog: (m: string) => void;
    sleep?: (ms: number) => Promise<void>;
    currentConfig: () => GatewayConfig;
    reply: (ch: string, threadTs: string, text: string) => Promise<void>;
  }
  export class ReviewRunner {
    constructor(deps: ReviewRunnerDeps);
    runOne(ref: PrRef, ctx: { /* unchanged from the current signature */ }, mode: "review" | "approve"): Promise<void>;
    drainOnShutdown(log: (msg: string) => void): number;
  }
  ```
  `backoff` and `replyWithTs` become private members of `ReviewRunner`.

- [ ] **Step 1: Record the baseline**

```bash
npm test --workspace=packages/cli 2>&1 | grep -E "^ℹ (tests|pass|fail)"
wc -l packages/cli/src/gateway/slack/review.ts
```

Expected: `tests 1151`, `pass 1151`, `fail 0`, and 910 lines. Write both down — later steps must match.

- [ ] **Step 2: Create the module**

`packages/cli/src/gateway/slack/review-runner.ts`:

```ts
/**
 * Runs one PR review to completion, tracks it while in flight, and drains it
 * on shutdown.
 *
 * runOne is an acquire → work → release bracket: claim, in-flight
 * registration, progress bar, workspace clone. Its correctness protocol is
 * that every early exit passes through the `finally`, which reads `posted` to
 * decide whether the claim survives as an idempotency record or is released
 * for retry. That is why the bracket is NOT split — it moved whole, and the
 * state it owns (`inFlight`) moved with it.
 */
import type { WebClient } from "@slack/web-api";
import type { GatewayConfig } from "../config";
import type { ReviewGateway } from "./review";

export interface ReviewRunnerDeps {
  gateway: ReviewGateway;
  web: WebClient;
  onLog: (m: string) => void;
  /** Injectable sleep for the retry backoff; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * MUST stay a function. runOne re-reads live config at post time to
   * re-validate policy before the GitHub POST; a snapshot would let a revoked
   * policy through.
   */
  currentConfig: () => GatewayConfig;
  reply: (ch: string, threadTs: string, text: string) => Promise<void>;
}

export class ReviewRunner {
  constructor(private readonly deps: ReviewRunnerDeps) {}
}
```

- [ ] **Step 3: Move `InFlightReview` and the `inFlight` field**

Move the `InFlightReview` interface from `review.ts` into `review-runner.ts` and export it (`review.ts` may still reference the type; import it back with `import type` if so). Move the `private readonly inFlight = new Set<InFlightReview>()` field onto `ReviewRunner`.

- [ ] **Step 4: Move the four members verbatim**

Move `runOne`, `drainOnShutdown`, `backoff` and `replyWithTs` from `review.ts` into `ReviewRunner`. `runOne` and `drainOnShutdown` are public; `backoff` and `replyWithTs` stay private.

Apply exactly these substitutions inside the moved bodies, and no others:

| From | To |
|---|---|
| `const { gateway, onLog } = this.opts;` | `const { gateway, onLog } = this.deps;` |
| `this.opts.web` | `this.deps.web` |
| `this.opts.onLog` | `this.deps.onLog` |
| `this.opts.sleep` | `this.deps.sleep` |
| `this.currentConfig()` | `this.deps.currentConfig()` |
| `this.reply(` | `this.deps.reply(` |
| `this.backoff(` | `this.backoff(` *(unchanged — now intra-class)* |
| `this.replyWithTs(` | `this.replyWithTs(` *(unchanged)* |
| `this.inFlight` | `this.inFlight` *(unchanged)* |

- [ ] **Step 5: Wire it into ReviewCoordinator**

Declare the field and assign it in the constructor body, next to `approveFlow`:

```ts
  private readonly runner: ReviewRunner;
```

```ts
    this.runner = new ReviewRunner({
      gateway: this.opts.gateway,
      web: this.opts.web,
      onLog: this.opts.onLog,
      sleep: this.opts.sleep,
      currentConfig: () => this.currentConfig(),
      reply: (ch, ts, text) => this.reply(ch, ts, text),
    });
```

Replace the two `await this.runOne(...)` call sites (one in `processApproveRequest`, one in `processReviewRequest`) with `await this.runner.runOne(...)`, arguments unchanged.

Replace `drainOnShutdown`'s body with the delegation, keeping its signature:

```ts
  drainOnShutdown(log: (msg: string) => void): number {
    return this.runner.drainOnShutdown(log);
  }
```

Add `import { ReviewRunner } from "./review-runner";`

- [ ] **Step 6: Run the suite**

```bash
npm test --workspace=packages/cli 2>&1 | grep -E "error TS|^ℹ (tests|pass|fail)|✖ failing"
```

Expected: the counts from Step 1, `fail 0`, no `error TS`. A failure means the move was not verbatim — re-diff the moved block; do not edit a test.

- [ ] **Step 7: Remove imports left unused in review.ts, then re-run**

```bash
npx tsc -p packages/cli/tsconfig.json --noEmit
npm test --workspace=packages/cli 2>&1 | grep -E "error TS|^ℹ (tests|pass|fail)"
```

Determine unused imports by searching `review.ts` for each symbol you moved. Do not guess.

- [ ] **Step 8: Confirm the ceiling is cleared**

```bash
wc -l packages/cli/src/gateway/slack/review.ts packages/cli/src/gateway/slack/review-runner.ts
```

Expected: `review.ts` ~598 (**under 800** — the point of the exercise), runner ~350.

- [ ] **Step 9: Verify the diff is a pure move**

```bash
git diff packages/cli/src/gateway/slack/review.ts | grep "^-" | grep -v "^---" | wc -l
```

Read the removed block against the added one and confirm the only differences are the Step 4 substitutions. Pay particular attention to the Traditional Chinese user-facing strings.

- [ ] **Step 10: Run every workspace**

```bash
for w in packages/cli packages/core packages/llm packages/rag packages/shared apps/desktop; do
  out=$(npm test --workspace=$w 2>&1)
  echo "$w exit=$? $(echo "$out" | grep -E '^ℹ (tests|pass|fail) ' | tr '\n' ' ')"
done
```

Expected: every workspace `fail 0`. Sum the per-workspace `tests` numbers for the commit message.

- [ ] **Step 11: Commit**

```bash
git add packages/cli/src/gateway/slack/review-runner.ts packages/cli/src/gateway/slack/review.ts
git commit -m "refactor(gateway): extract the review runner from review.ts

Moves runOne, drainOnShutdown, backoff, replyWithTs and the inFlight
registry into ReviewRunner. These are the only members that touch
inFlight, so the shared state moves with them rather than staying spread
across a coordinator that no longer uses it.

The acquire -> work -> release bracket moved WHOLE, not split: its
protocol (every early exit passes through the finally, which reads
\`posted\` to decide the claim's fate) stays locally verifiable.

review.ts 910 -> ~598, under the 800 ceiling. Public API unchanged;
slack/index.ts and every test untouched."
```

---

## Verification before opening the PR

- [ ] every workspace green, counts summed per workspace
- [ ] no test file modified (`git diff main --stat -- packages/cli/test/` is empty)
- [ ] `slack/index.ts` untouched
- [ ] `review.ts` under 800 lines
- [ ] no user-facing string altered

## Self-review notes

**Spec coverage:** the unit (Task 1 Steps 2–4), the seam (Step 2 + Step 5), behaviour preservation (Global Constraints + Step 9), error handling (unchanged by construction — nothing inside the moved code is edited), testing (existing suite unchanged, Steps 6/10), the ceiling result (Step 8).

**Not covered by any task, by design:** direct `ReviewRunner` tests, the request-handling layer, and the other three oversized files. All named in the spec as out of scope.
