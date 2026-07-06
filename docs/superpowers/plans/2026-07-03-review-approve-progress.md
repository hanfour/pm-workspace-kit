# Review Approve + Progress Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI review approval actually land on GitHub (config-gated), add a live Slack percentage progress bar to reviews, and add a `:a: <PR url>` command that fast-reviews then approves iff no high-severity issue.

**Architecture:** Items 1, 2, 3a live in `pm-workspace-kit` (gateway TypeScript). Item 3b is a small policy addition in `multi-repo-agent/lib/review.sh` (bash). The gateway reuses the whole `:cr:` review pipeline (workspace isolation, claim, identity guards, detached exec, shutdown drain); `:a:` differs only in strategy (`standard`), forced approve env, and a severity-gated approve policy.

**Tech Stack:** TypeScript (Node 22, `@slack/web-api`), Vitest; bash + `jq` (mra), bats-style `tests/test_*.sh`.

## Global Constraints

- Immutability: return new objects; never mutate config/args in place.
- No hardcoded secrets; env-var / config only.
- Files focused (<800 lines); extract a new module rather than growing `review.ts`.
- TDD: failing test first, minimal impl, commit per task.
- `review.allowApprove` defaults to `false` (safe). `:a:` forces approve **per-invocation**, independent of that global default.
- "high-severity" ≡ `CRITICAL` or `HIGH`. `MEDIUM`/`LOW` are minor and allowed through the `:a:` gate.
- Progress bar: never reaches 100% until the review actually finishes (anti-freeze). `▰` filled / `▱` empty, 5 cells.
- mra strategies: `light | standard | debate`. Gateway uses `debate` (`:cr:`) and `standard` (`:a:`); `personas` is env-flagged (no `--strategy`).

---

## File Structure

**pm-workspace-kit:**
- Modify `packages/cli/src/gateway/config.ts` — `ReviewConfig.allowApprove`; parse + default.
- Modify `packages/cli/src/adapters/mra.ts` — widen strategy to include `standard`; `reviewEnv`/`runMraReview`/`buildReviewArgv` gain `allowApprove` + `approveIfNoHigh`.
- Create `packages/cli/src/gateway/slack/review-progress.ts` — progress rendering (pure fns + timer class).
- Modify `packages/cli/src/gateway/slack/review.ts` — `isApproveRequest`; `replyWithTs`; per-PR progress; `processApproveRequest`/`approveOne`.
- Modify `packages/cli/src/gateway/slack/index.ts` — route `:a:` at the two message sites + reaction site.
- Tests: `packages/cli/test/review-config.test.ts`, `mra-review.test.ts`, `review-progress.test.ts` (new), `review-coordinator.test.ts`.

**multi-repo-agent:**
- Modify `lib/review.sh` — `_review_effective_status`; apply at the `event=` site.
- Test: `tests/test_review_approve_gate.sh` (new).

**Delivery:** PR B (mra Task 8) should land or fix its env contract before PR A's `:a:` path (Tasks 9–11) is enabled. Tasks 1–7 (PR A: Items 1, 2, strategy-widening) are independent of mra.

---

## Task 1: `review.allowApprove` config field

**Files:**
- Modify: `packages/cli/src/gateway/config.ts:106-122` (`ReviewConfig`), `:353-371` (`normaliseReviewConfig`), `:462-472` (`resolveReviewConfig`)
- Test: `packages/cli/test/review-config.test.ts`

**Interfaces:**
- Produces: `ReviewConfig.allowApprove: boolean` (default `false`); parsed from a boolean `allowApprove` key.

- [ ] **Step 1: Write the failing test**

```typescript
// in packages/cli/test/review-config.test.ts
import { resolveReviewConfig, normaliseReviewConfigForTest } from "../src/gateway/config";
// If no test seam exists, test resolveReviewConfig with a Partial directly.

test("allowApprove defaults to false", () => {
  expect(resolveReviewConfig({}).allowApprove).toBe(false);
});

test("allowApprove passes through when true", () => {
  expect(resolveReviewConfig({ allowApprove: true }).allowApprove).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix packages/cli test -- review-config`
Expected: FAIL — `allowApprove` missing from `ReviewConfig` / `resolveReviewConfig` result.

- [ ] **Step 3: Implement**

In `ReviewConfig` (after `expectedGhUser?`), add:
```typescript
  /** Allow an AI APPROVED verdict to post as a real GitHub APPROVE (sets
   * MRA_REVIEW_ALLOW_APPROVE=1). Default false → verdict downgraded to COMMENT. */
  allowApprove: boolean;
```
In `normaliseReviewConfig` (before the `ghToken` line):
```typescript
  if (typeof o.allowApprove === "boolean") out.allowApprove = o.allowApprove;
```
In `resolveReviewConfig` return object:
```typescript
    allowApprove: raw?.allowApprove ?? false,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix packages/cli test -- review-config`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/config.ts packages/cli/test/review-config.test.ts
git commit -m "feat(review): add review.allowApprove config (default false)"
```

---

## Task 2: Widen review strategy to include `standard`

**Files:**
- Modify: `packages/cli/src/adapters/mra.ts:535-542` (`buildReviewArgv`), `:576-596` (`reviewEnv`), `:750-762` (`runMraReview` args), `packages/cli/src/gateway/config.ts:111` (`ReviewConfig.strategy`), `:364-365` (`normaliseReviewConfig`), `:467` (`resolveReviewConfig`)
- Test: `packages/cli/test/mra-review.test.ts`

**Interfaces:**
- Produces: strategy type is `"debate" | "personas" | "standard"` everywhere; `buildReviewArgv(project, pr, "standard")` → `[..., "--strategy", "standard"]`.

- [ ] **Step 1: Write the failing test**

```typescript
// in packages/cli/test/mra-review.test.ts
import { buildReviewArgv } from "../src/adapters/mra";

test("standard strategy maps to --strategy standard", () => {
  expect(buildReviewArgv("superdsp-ui", 547, "standard")).toEqual([
    "review", "superdsp-ui", "--pr", "547", "--strategy", "standard",
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix packages/cli test -- mra-review`
Expected: FAIL — TS type error (`"standard"` not assignable) or wrong argv.

- [ ] **Step 3: Implement**

Define a shared type at the top of `mra.ts` (near other exports):
```typescript
export type ReviewStrategy = "debate" | "personas" | "standard";
```
Replace `strategy: "debate" | "personas"` with `strategy: ReviewStrategy` in `buildReviewArgv`, `reviewEnv`, and `runMraReview`'s `args`. Update `buildReviewArgv` body:
```typescript
  const base = ["review", project, "--pr", String(pr)];
  if (strategy === "debate") return [...base, "--strategy", "debate"];
  if (strategy === "standard") return [...base, "--strategy", "standard"];
  return base; // personas → env flag only
```
In `config.ts`: change `ReviewConfig.strategy` to `"debate" | "personas" | "standard"`; in `normaliseReviewConfig` accept `"standard"`:
```typescript
  if (o.strategy === "debate" || o.strategy === "personas" || o.strategy === "standard")
    out.strategy = o.strategy;
```
`resolveReviewConfig` keeps `raw?.strategy === "personas" ? "personas" : "debate"` — the config default stays `debate` for `:cr:`; `standard` is only ever passed explicitly by `:a:` (Task 10). Leave that line unchanged (a config author CAN set `standard`, but then normalise keeps it and resolve maps non-personas → debate; acceptable — document that `standard` is `:a:`-internal). To allow `standard` as a config value too, change the map to:
```typescript
    strategy: raw?.strategy === "personas" ? "personas"
      : raw?.strategy === "standard" ? "standard" : "debate",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix packages/cli test -- mra-review`
Expected: PASS. Also run `npm --prefix packages/cli run build` (or `tsc --noEmit`) to confirm no type breaks.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/adapters/mra.ts packages/cli/src/gateway/config.ts packages/cli/test/mra-review.test.ts
git commit -m "feat(review): support 'standard' single-agent strategy"
```

---

## Task 3: `reviewEnv` sets approve env flags

**Files:**
- Modify: `packages/cli/src/adapters/mra.ts:576-596` (`reviewEnv`), `:750-779` (`runMraReview` args + call)
- Test: `packages/cli/test/mra-review.test.ts`

**Interfaces:**
- Consumes: `ReviewStrategy` (Task 2).
- Produces: `reviewEnv(strategy, ghToken, opts?: { allowApprove?: boolean; approveIfNoHigh?: boolean })`; `runMraReview` args gain `allowApprove?: boolean` and `approveIfNoHigh?: boolean`, forwarded to `reviewEnv`.

- [ ] **Step 1: Write the failing test**

```typescript
// in packages/cli/test/mra-review.test.ts
import { reviewEnv } from "../src/adapters/mra";

test("allowApprove sets MRA_REVIEW_ALLOW_APPROVE", () => {
  const env = reviewEnv("debate", undefined, { allowApprove: true });
  expect(env.MRA_REVIEW_ALLOW_APPROVE).toBe("1");
});

test("no approve flag by default", () => {
  const env = reviewEnv("debate");
  expect(env.MRA_REVIEW_ALLOW_APPROVE).toBeUndefined();
  expect(env.MRA_REVIEW_APPROVE_IF_NO_HIGH).toBeUndefined();
});

test("approveIfNoHigh sets MRA_REVIEW_APPROVE_IF_NO_HIGH", () => {
  const env = reviewEnv("standard", undefined, { approveIfNoHigh: true });
  expect(env.MRA_REVIEW_APPROVE_IF_NO_HIGH).toBe("1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix packages/cli test -- mra-review`
Expected: FAIL — `reviewEnv` ignores the 3rd arg.

- [ ] **Step 3: Implement**

Change `reviewEnv` signature + body:
```typescript
export function reviewEnv(
  strategy: ReviewStrategy,
  ghToken?: string,
  opts: { allowApprove?: boolean; approveIfNoHigh?: boolean } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of REVIEW_SECRET_ENV_DENYLIST) delete env[k];
  if (ghToken) env.GH_TOKEN = ghToken;
  if (strategy === "personas") env.MRA_REVIEW_PERSONAS = "true";
  if (opts.allowApprove) env.MRA_REVIEW_ALLOW_APPROVE = "1";
  if (opts.approveIfNoHigh) env.MRA_REVIEW_APPROVE_IF_NO_HIGH = "1";
  if (!env.MRA_REVIEW_AGENT_MAX_TURNS) env.MRA_REVIEW_AGENT_MAX_TURNS = "40";
  return env;
}
```
In `runMraReview` `args`, add `allowApprove?: boolean;` and `approveIfNoHigh?: boolean;`. Change the `reviewEnv` call:
```typescript
  const env = reviewEnv(args.strategy, args.ghToken, {
    allowApprove: args.allowApprove,
    approveIfNoHigh: args.approveIfNoHigh,
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix packages/cli test -- mra-review`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/adapters/mra.ts packages/cli/test/mra-review.test.ts
git commit -m "feat(review): reviewEnv wires MRA_REVIEW_ALLOW_APPROVE / APPROVE_IF_NO_HIGH"
```

---

## Task 4: `:cr:` passes `allowApprove` from config

**Files:**
- Modify: `packages/cli/src/gateway/slack/review.ts:442-453` (`runMraReview` call in `reviewOne`)
- Test: `packages/cli/test/review-coordinator.test.ts`

**Interfaces:**
- Consumes: `runMraReview` `allowApprove` arg (Task 3), `ctx.review.allowApprove` (Task 1).

- [ ] **Step 1: Write the failing test**

```typescript
// in review-coordinator.test.ts — use the existing fake ReviewGateway pattern.
// Capture the args passed to runMraReview and assert allowApprove is forwarded.
test("reviewOne forwards config allowApprove to runMraReview", async () => {
  const calls: any[] = [];
  const gateway = makeFakeGateway({ runMraReview: async (a: any) => { calls.push(a); return { ok: true, status: "APPROVED", commentCount: 0, stdout: "", stderr: "" }; } });
  const coord = makeCoordinator({ gateway, review: { enabled: true, allowApprove: true, /* ...defaults */ } });
  await coord.fromMessage({ channelId: "C", threadTs: "1", userId: "U", text: ":cr: https://github.com/onead/superdsp-ui/pull/547" });
  expect(calls[0].allowApprove).toBe(true);
});
```
(Use the file's existing fake-gateway/coordinator helpers; mirror an existing `runMraReview` test's setup for guards that must pass — private repo, expectedGhUser, claim.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix packages/cli test -- review-coordinator`
Expected: FAIL — `allowApprove` is `undefined` in the captured args.

- [ ] **Step 3: Implement**

In `reviewOne`'s `runMraReview` call, add:
```typescript
          allowApprove: ctx.review.allowApprove,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix packages/cli test -- review-coordinator`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/slack/review.ts packages/cli/test/review-coordinator.test.ts
git commit -m "feat(review): :cr: honors review.allowApprove"
```

---

---

## Task 5: Progress-bar pure functions

**Files:**
- Create: `packages/cli/src/gateway/slack/review-progress.ts`
- Test: `packages/cli/test/review-progress.test.ts`

**Interfaces:**
- Produces:
  - `type Phase = "prepare" | "pkb" | "analyze" | "posting" | "done"`
  - `phaseFromLine(line: string): Phase | undefined`
  - `computePct(phase: Phase, elapsedInPhaseMs: number, strategy: ReviewStrategy): number`
  - `renderBar(pct: number, phaseLabel: string, headline: string): string`
  - `PHASE_LABEL: Record<Phase, string>`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/cli/test/review-progress.test.ts
import { phaseFromLine, computePct, renderBar } from "../src/gateway/slack/review-progress";

test("phaseFromLine maps mra stdout markers", () => {
  expect(phaseFromLine("[review] PKB available — using knowledge base")).toBe("pkb");
  expect(phaseFromLine("[review] loaded existing PR discussion into review context")).toBe("analyze");
  expect(phaseFromLine("[review] posting inline review to onead/superdsp-ui#547 (3 comments)...")).toBe("posting");
  expect(phaseFromLine("[review] review posted: onead/superdsp-ui#547 (review #1)")).toBe("done");
  expect(phaseFromLine("some unrelated line")).toBeUndefined();
});

test("computePct: analyze creeps but never reaches 100", () => {
  const early = computePct("analyze", 0, "debate");        // floor 35
  const late = computePct("analyze", 10 * 60_000, "debate"); // long past estimate
  expect(early).toBe(35);
  expect(late).toBeGreaterThan(early);
  expect(late).toBeLessThanOrEqual(85); // ANALYZE_CAP
});

test("computePct: only done is 100", () => {
  expect(computePct("done", 0, "debate")).toBe(100);
  expect(computePct("posting", 0, "debate")).toBe(90);
  expect(computePct("prepare", 0, "debate")).toBe(5);
});

test("renderBar draws 5 cells", () => {
  expect(renderBar(60, "分析中(debate)", ":mag: review #547")).toBe(
    ":mag: review #547\n▰▰▰▱▱ 60%\n目前:分析中(debate)",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix packages/cli test -- review-progress`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```typescript
// packages/cli/src/gateway/slack/review-progress.ts
import type { ReviewStrategy } from "../../adapters/mra";

export type Phase = "prepare" | "pkb" | "analyze" | "posting" | "done";

const PHASE_FLOOR: Record<Phase, number> = {
  prepare: 5, pkb: 20, analyze: 35, posting: 90, done: 100,
};
const ANALYZE_CAP = 85;
const EXPECTED_ANALYZE_MS: Record<ReviewStrategy, number> = {
  debate: 210_000, personas: 210_000, standard: 90_000,
};
export const PHASE_LABEL: Record<Phase, string> = {
  prepare: "準備工作區", pkb: "建立/載入知識庫", analyze: "分析中",
  posting: "貼上 review", done: "完成",
};

/** Map an mra `onProgress` stdout line to a phase (undefined = no transition). */
export function phaseFromLine(line: string): Phase | undefined {
  if (line.includes("review posted")) return "done";
  if (line.includes("posting inline review")) return "posting";
  if (line.includes("loaded existing PR discussion")) return "analyze";
  if (line.includes("PKB available") || line.includes("updating PKB")) return "pkb";
  if (line.includes("reviewing ")) return "prepare";
  return undefined;
}

/** Clamped, monotonic percent. `analyze` creeps by elapsed time toward ANALYZE_CAP. */
export function computePct(phase: Phase, elapsedInPhaseMs: number, strategy: ReviewStrategy): number {
  if (phase !== "analyze") return PHASE_FLOOR[phase];
  const floor = PHASE_FLOOR.analyze;
  const span = ANALYZE_CAP - floor;
  const frac = Math.min(1, Math.max(0, elapsedInPhaseMs / EXPECTED_ANALYZE_MS[strategy]));
  return Math.min(ANALYZE_CAP, Math.round(floor + span * frac));
}

/** `<headline>\n▰▰▰▱▱ NN%\n目前:<label>` — 5 cells, round(pct/20) filled. */
export function renderBar(pct: number, phaseLabel: string, headline: string): string {
  const filled = Math.max(0, Math.min(5, Math.round(pct / 20)));
  const bar = "▰".repeat(filled) + "▱".repeat(5 - filled);
  return `${headline}\n${bar} ${pct}%\n目前:${phaseLabel}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix packages/cli test -- review-progress`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/slack/review-progress.ts packages/cli/test/review-progress.test.ts
git commit -m "feat(review): progress-bar pure functions (phase/pct/render)"
```

---

## Task 6: `ReviewProgress` timer class

**Files:**
- Modify: `packages/cli/src/gateway/slack/review-progress.ts`
- Test: `packages/cli/test/review-progress.test.ts`

**Interfaces:**
- Consumes: `phaseFromLine`, `computePct`, `renderBar`, `PHASE_LABEL`.
- Produces: `class ReviewProgress` with `constructor(deps: { web: Pick<WebClient,"chat">; channel: string; ts: string; strategy: ReviewStrategy; headline: string; now?: () => number; setTimer?; clearTimer? })`, methods `onLine(line: string): void`, `finish(finalText: string): Promise<void>`, `dispose(): void`. Ticks every `TICK_MS` (5000); calls `chat.update` only when the rendered string changed.

- [ ] **Step 1: Write the failing test**

```typescript
// append to review-progress.test.ts
import { ReviewProgress } from "../src/gateway/slack/review-progress";

function fakeWeb() {
  const updates: string[] = [];
  return { updates, web: { chat: { update: async ({ text }: any) => { updates.push(text); return {}; } } } };
}

test("updates only when render changes; finish converges to 100 + final text", async () => {
  let clock = 0;
  const timers: Array<() => void> = [];
  const { web, updates } = fakeWeb();
  const p = new ReviewProgress({
    web: web as any, channel: "C", ts: "1", strategy: "standard", headline: ":mag: review #547",
    now: () => clock,
    setTimer: (fn: () => void) => { timers.push(fn); return 1 as any; },
    clearTimer: () => {},
  });
  p.onLine("[review] loaded existing PR discussion into review context"); // → analyze
  timers[0](); // tick: pct 35
  clock = 90_000; timers[0](); // tick: pct creeps up
  const analyzeUpdates = updates.length;
  timers[0](); // same clock → no new update
  expect(updates.length).toBe(analyzeUpdates);
  await p.finish(":white_check_mark: 已 approve #547");
  expect(updates[updates.length - 1]).toBe(":white_check_mark: 已 approve #547");
});

test("dispose clears the timer", () => {
  let cleared = 0;
  const { web } = fakeWeb();
  const p = new ReviewProgress({
    web: web as any, channel: "C", ts: "1", strategy: "debate", headline: "h",
    now: () => 0, setTimer: () => 7 as any, clearTimer: () => { cleared++; },
  });
  p.dispose();
  expect(cleared).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix packages/cli test -- review-progress`
Expected: FAIL — `ReviewProgress` not exported.

- [ ] **Step 3: Implement**

```typescript
// append to review-progress.ts
import type { WebClient } from "@slack/web-api";

const TICK_MS = 5000;

interface ProgressDeps {
  web: Pick<WebClient, "chat">;
  channel: string;
  ts: string;
  strategy: ReviewStrategy;
  headline: string;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearTimer?: (h: ReturnType<typeof setInterval>) => void;
}

export class ReviewProgress {
  private phase: Phase = "prepare";
  private phaseStart: number;
  private lastRender = "";
  private timer?: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  private readonly clearTimer: (h: ReturnType<typeof setInterval>) => void;

  constructor(private readonly d: ProgressDeps) {
    this.now = d.now ?? Date.now;
    this.clearTimer = d.clearTimer ?? clearInterval;
    this.phaseStart = this.now();
    const set = d.setTimer ?? setInterval;
    this.timer = set(() => void this.tick(), TICK_MS);
  }

  onLine(line: string): void {
    const next = phaseFromLine(line);
    if (next && next !== this.phase) {
      this.phase = next;
      this.phaseStart = this.now();
      void this.tick();
    }
  }

  private async tick(): Promise<void> {
    if (this.phase === "done") return;
    const pct = computePct(this.phase, this.now() - this.phaseStart, this.d.strategy);
    const text = renderBar(pct, PHASE_LABEL[this.phase], this.d.headline);
    if (text === this.lastRender) return;
    this.lastRender = text;
    try {
      await this.d.web.chat.update({ channel: this.d.channel, ts: this.d.ts, text });
    } catch {
      /* best-effort; a Slack hiccup must not break the review */
    }
  }

  async finish(finalText: string): Promise<void> {
    this.dispose();
    try {
      await this.d.web.chat.update({ channel: this.d.channel, ts: this.d.ts, text: finalText });
    } catch {
      /* best-effort */
    }
  }

  dispose(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix packages/cli test -- review-progress`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/slack/review-progress.ts packages/cli/test/review-progress.test.ts
git commit -m "feat(review): ReviewProgress timer with change-gated chat.update"
```

---

## Task 7: Wire the progress bar into `reviewOne`

**Files:**
- Modify: `packages/cli/src/gateway/slack/review.ts` (`reply` → add `replyWithTs`; `reviewOne` posts a progress message, feeds `onProgress`, `finish`/`dispose`; `drainOnShutdown` disposes)
- Test: `packages/cli/test/review-coordinator.test.ts`

**Interfaces:**
- Consumes: `ReviewProgress` (Task 6).
- Produces: `private async replyWithTs(channel, threadTs, text): Promise<string | undefined>` (returns message `ts`).

- [ ] **Step 1: Write the failing test**

```typescript
// review-coordinator.test.ts — assert chat.update is called during a review and
// the final result text lands via update (not a second postMessage).
test("reviewOne shows progress then finishes with the result text", async () => {
  const updates: string[] = [];
  const web = makeFakeWeb({
    chatPostMessage: async () => ({ ts: "P1" }),
    chatUpdate: async ({ text }: any) => { updates.push(text); return {}; },
  });
  const gateway = makeFakeGateway({
    runMraReview: async (_a: any, o: any) => {
      o.onProgress?.("[review] loaded existing PR discussion into review context");
      o.onProgress?.("[review] posting inline review to onead/superdsp-ui#547 (0 comments)...");
      return { ok: true, status: "APPROVED", commentCount: 0, stdout: "", stderr: "" };
    },
  });
  const coord = makeCoordinator({ web, gateway, review: { enabled: true, allowApprove: true } });
  await coord.fromMessage({ channelId: "C", threadTs: "1", userId: "U", text: ":cr: https://github.com/onead/superdsp-ui/pull/547" });
  expect(updates.some((t) => t.includes("▰"))).toBe(true);           // progress rendered
  expect(updates[updates.length - 1]).toContain("已對");             // result via update
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix packages/cli test -- review-coordinator`
Expected: FAIL — no `chat.update` calls (progress not wired).

- [ ] **Step 3: Implement**

Add near `reply`:
```typescript
  /** Like reply() but returns the posted message ts (for in-place progress edits). */
  private async replyWithTs(channel: string, threadTs: string, text: string): Promise<string | undefined> {
    try {
      const res = (await this.opts.web.chat.postMessage({ channel, thread_ts: threadTs, text })) as { ts?: string };
      return res.ts;
    } catch (err) {
      this.opts.onLog(`review: reply failed: ${(err as Error).message}`);
      return undefined;
    }
  }
```
In `reviewOne`, import `ReviewProgress` at top. After the claim succeeds and before `runMraReview`, create the progress message:
```typescript
    const progressTs = await this.replyWithTs(
      ctx.channelId, ctx.threadTs,
      `:mag: review ${slug}#${ref.number}\n▱▱▱▱▱ 5%\n目前:${"準備工作區"}`,
    );
    const progress = progressTs
      ? new ReviewProgress({ web: this.opts.web, channel: ctx.channelId, ts: progressTs, strategy: ctx.review.strategy, headline: `:mag: review ${slug}#${ref.number}` })
      : undefined;
```
Change the `runMraReview` `onProgress` to also feed progress:
```typescript
        { onProgress: (line) => { onLog(`mra review ${slug}#${ref.number}: ${line}`); progress?.onLine(line); } },
```
On success, replace the `await this.reply(... :white_check_mark: ...)` with:
```typescript
      const resultText = `:white_check_mark: 已對 ${slug}#${ref.number} 貼 review（${res.status ?? "COMMENT"}，${res.commentCount ?? 0} 則）：${ref.url}`;
      if (progress) await progress.finish(resultText);
      else await this.reply(ctx.channelId, ctx.threadTs, resultText);
```
In the `catch` and each `skip(...)` inside `reviewOne`, and in `finally`, call `progress?.dispose()` so the timer never leaks (add `progress?.dispose();` at the top of `finally`). In `drainOnShutdown`, progress objects live in `reviewOne`'s closure; since the shutdown path aborts the controller which settles `runMraReview`, the `finally` runs and disposes — no extra tracking needed. Add a comment noting this.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix packages/cli test -- review-coordinator`
Expected: PASS. Run the whole suite: `npm --prefix packages/cli test`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/slack/review.ts packages/cli/test/review-coordinator.test.ts
git commit -m "feat(review): live Slack progress bar for :cr: reviews"
```

---

---

## Task 8: mra `_review_effective_status` policy (multi-repo-agent — PR B)

**Files:**
- Modify: `lib/review.sh` — add `_review_effective_status` near `_review_event_for_status` (~line 94); apply at the `event=$(_review_event_for_status "$status")` call site (~line 709).
- Test: `tests/test_review_approve_gate.sh` (new)

**Interfaces:**
- Produces: `_review_effective_status <status> <review_json>` → echoes the effective status. Under `MRA_REVIEW_APPROVE_IF_NO_HIGH=1` AND `MRA_REVIEW_ALLOW_APPROVE=1`: `APPROVED` if no comment severity is `CRITICAL`/`HIGH`, else `CHANGES_REQUESTED`. Otherwise echoes `<status>` unchanged.

- [ ] **Step 1: Write the failing test**

```bash
# tests/test_review_approve_gate.sh
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source lib/colors.sh 2>/dev/null || true
source lib/review.sh

fail=0
check() { if [[ "$1" == "$2" ]]; then echo "ok: $3"; else echo "FAIL: $3 (got '$1' want '$2')"; fail=1; fi; }

json_clean='{"status":"CHANGES_REQUESTED","summary":"x","comments":[{"path":"a","line":1,"body":"nit","severity":"LOW"}]}'
json_high='{"status":"APPROVED","summary":"x","comments":[{"path":"a","line":1,"body":"bug","severity":"HIGH"}]}'

MRA_REVIEW_APPROVE_IF_NO_HIGH=1 MRA_REVIEW_ALLOW_APPROVE=1 \
  check "$(_review_effective_status CHANGES_REQUESTED "$json_clean")" "APPROVED" "no-high → APPROVED"
MRA_REVIEW_APPROVE_IF_NO_HIGH=1 MRA_REVIEW_ALLOW_APPROVE=1 \
  check "$(_review_effective_status APPROVED "$json_high")" "CHANGES_REQUESTED" "has-high → CHANGES_REQUESTED"
# policy off → pass status through unchanged
check "$(_review_effective_status APPROVED "$json_high")" "APPROVED" "policy-off passthrough"

exit $fail
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test_review_approve_gate.sh`
Expected: FAIL — `_review_effective_status: command not found`.

- [ ] **Step 3: Implement**

Add after `_review_event_for_status` in `lib/review.sh`:
```bash
# _review_effective_status: under the :a: approve-if-no-high policy, derive the
# effective status from comment severity so the posted event, the review body,
# and the `status:` stdout line all agree. Requires BOTH the policy flag and the
# operator approve opt-in; otherwise the model status passes through unchanged.
_review_effective_status() {
  local status="${1:-}" review_json="${2:-}"
  if [[ "${MRA_REVIEW_APPROVE_IF_NO_HIGH:-}" == "1" && "${MRA_REVIEW_ALLOW_APPROVE:-}" == "1" ]]; then
    local high_count
    high_count=$(printf '%s' "$review_json" \
      | jq -r '[.comments[]? | select(.severity == "CRITICAL" or .severity == "HIGH")] | length' 2>/dev/null)
    if [[ "${high_count:-0}" -eq 0 ]]; then echo "APPROVED"; else echo "CHANGES_REQUESTED"; fi
    return 0
  fi
  echo "$status"
}
```
At the event call site (replace the two lines):
```bash
  status=$(_review_effective_status "$status" "$review_json")
  local event
  event=$(_review_event_for_status "$status")
```
(`status` is reassigned before it feeds the body + the `status: <STATUS> | comments: <N>` stdout line, so all three agree.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test_review_approve_gate.sh`
Expected: PASS. Also run the existing review tests: `bash tests/test_review_safety.sh && bash tests/test_review_debate.sh`.

- [ ] **Step 5: Commit (in multi-repo-agent)**

```bash
cd ~/multi-repo-agent
git checkout -b feat/approve-if-no-high
git add lib/review.sh tests/test_review_approve_gate.sh
git commit -m "feat(review): MRA_REVIEW_APPROVE_IF_NO_HIGH approve gate (:a: policy)"
```

---

## Task 9: `isApproveRequest` parser

**Files:**
- Modify: `packages/cli/src/gateway/slack/review.ts` (add `isApproveRequest`)
- Test: `packages/cli/test/review-coordinator.test.ts`

**Interfaces:**
- Produces: `export function isApproveRequest(text: string): boolean` — true iff text contains `:a:` AND ≥1 PR ref.

- [ ] **Step 1: Write the failing test**

```typescript
import { isApproveRequest, isReviewRequest } from "../src/gateway/slack/review";

test("isApproveRequest needs :a: and a PR ref", () => {
  expect(isApproveRequest(":a: https://github.com/onead/superdsp-ui/pull/547")).toBe(true);
  expect(isApproveRequest(":a: no pr here")).toBe(false);
  expect(isApproveRequest("https://github.com/onead/superdsp-ui/pull/547")).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix packages/cli test -- review-coordinator`
Expected: FAIL — `isApproveRequest` not exported.

- [ ] **Step 3: Implement**

```typescript
/**
 * True when a message is an inline `:a:` approve request: it contains the `:a:`
 * token AND at least one GitHub PR link. `:a:` runs a fast single-agent review
 * then approves iff no high-severity issue is found.
 */
export function isApproveRequest(text: string): boolean {
  return text.includes(":a:") && parsePrRefs(text).length > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix packages/cli test -- review-coordinator`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/slack/review.ts packages/cli/test/review-coordinator.test.ts
git commit -m "feat(review): isApproveRequest parser for :a:"
```

---

## Task 10: `approveOne` + `processApproveRequest`

**Files:**
- Modify: `packages/cli/src/gateway/slack/review.ts` (add `processApproveRequest`, `approveOne`, `fromApproveMessage`, `fromApproveReaction`)
- Test: `packages/cli/test/review-coordinator.test.ts`

**Interfaces:**
- Consumes: same `ReviewGateway` methods as `reviewOne`; `runMraReview` `allowApprove`/`approveIfNoHigh` (Task 3); `ReviewProgress` (Task 6).
- Produces: `async fromApproveMessage({ channelId, threadTs, userId, text })`, `async fromApproveReaction({ channelId, messageTs, reactorUserId })`.

**Design:** `approveOne` mirrors `reviewOne`'s guards (resolveProject → slug → PR head → private/allowlist → claim → clone → identity) then calls `runMraReview` with `strategy: "standard"`, `allowApprove: true`, `approveIfNoHigh: true`. Result text depends on `res.status`:
- `APPROVED` → `:white_check_mark: 已 approve <slug>#<n>（無重大問題；<m> 則 minor 建議）：<url>`
- else → `:no_entry: 未 approve <slug>#<n> — 發現重大問題，已請求修改（<status>，<m> 則）：<url>`

- [ ] **Step 1: Write the failing test**

```typescript
test("approveOne approves when mra returns APPROVED", async () => {
  const posted: string[] = [];
  const web = makeFakeWeb({ chatPostMessage: async ({ text }: any) => { posted.push(text); return { ts: "P" }; }, chatUpdate: async ({ text }: any) => { posted.push(text); return {}; } });
  const gateway = makeFakeGateway({
    runMraReview: async (a: any) => { expect(a.strategy).toBe("standard"); expect(a.allowApprove).toBe(true); expect(a.approveIfNoHigh).toBe(true); return { ok: true, status: "APPROVED", commentCount: 1, stdout: "", stderr: "" }; },
  });
  const coord = makeCoordinator({ web, gateway, review: { enabled: true } });
  await coord.fromApproveMessage({ channelId: "C", threadTs: "1", userId: "U", text: ":a: https://github.com/onead/superdsp-ui/pull/547" });
  expect(posted.some((t) => t.includes("已 approve"))).toBe(true);
});

test("approveOne requests changes when mra returns CHANGES_REQUESTED", async () => {
  const posted: string[] = [];
  const web = makeFakeWeb({ chatPostMessage: async ({ text }: any) => { posted.push(text); return { ts: "P" }; }, chatUpdate: async ({ text }: any) => { posted.push(text); return {}; } });
  const gateway = makeFakeGateway({ runMraReview: async () => ({ ok: true, status: "CHANGES_REQUESTED", commentCount: 2, stdout: "", stderr: "" }) });
  const coord = makeCoordinator({ web, gateway, review: { enabled: true } });
  await coord.fromApproveMessage({ channelId: "C", threadTs: "1", userId: "U", text: ":a: https://github.com/onead/superdsp-ui/pull/547" });
  expect(posted.some((t) => t.includes("未 approve"))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix packages/cli test -- review-coordinator`
Expected: FAIL — `fromApproveMessage` not a function.

- [ ] **Step 3: Implement**

Refactor `reviewOne` to share its guard/claim/clone/identity prelude if practical; otherwise copy the prelude into `approveOne` (guards are the review contract — duplication is acceptable if a shared helper would over-couple). `approveOne`'s `runMraReview` call:
```typescript
      const res = await gateway.runMraReview(
        { workspace: ctx.reviewWorkspace, project, pr: ref.number, strategy: "standard",
          cwd: ctx.reviewWorkspace, ghToken: ctx.token, allowApprove: true, approveIfNoHigh: true,
          signal: controller.signal },
        { onProgress: (line) => { onLog(`mra approve ${slug}#${ref.number}: ${line}`); progress?.onLine(line); } },
      );
```
Result handling:
```typescript
      const approved = (res.status ?? "") === "APPROVED";
      const resultText = approved
        ? `:white_check_mark: 已 approve ${slug}#${ref.number}（無重大問題；${res.commentCount ?? 0} 則 minor 建議）：${ref.url}`
        : `:no_entry: 未 approve ${slug}#${ref.number} — 發現重大問題，已請求修改（${res.status ?? "COMMENT"}，${res.commentCount ?? 0} 則）：${ref.url}`;
      if (progress) await progress.finish(resultText); else await this.reply(ctx.channelId, ctx.threadTs, resultText);
```
`processApproveRequest` mirrors `processReviewRequest` but posts an approve-flavored ack (`:lock: 收到，先快速 review 再決定是否 approve…`), uses `strategy: "standard"` for the progress headline, and calls `approveOne`. `fromApproveMessage`/`fromApproveReaction` mirror `fromMessage`/`fromReaction`, delegating to `processApproveRequest`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix packages/cli test -- review-coordinator`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/gateway/slack/review.ts packages/cli/test/review-coordinator.test.ts
git commit -m "feat(review): :a: approve flow (fast review → gated approve)"
```

---

## Task 11: Route `:a:` in the Slack handler + document config

**Files:**
- Modify: `packages/cli/src/gateway/slack/index.ts:58` (import `isApproveRequest`), `:695` + `:843` (message routing), `:1013` (reaction routing)
- Modify: `README.md` / gateway config docs — document `review.allowApprove` + the `:a:` command.
- Test: manual smoke via the coordinator tests (Task 10 covers logic); routing verified by build + a light index test if one exists.

**Interfaces:**
- Consumes: `isApproveRequest` (Task 9), `fromApproveMessage`/`fromApproveReaction` (Task 10).

- [ ] **Step 1: Add routing (approve BEFORE review so `:a:` wins)**

At both message sites (`:695` and `:843`), immediately before the `isReviewRequest` block:
```typescript
    if (this.review.isEnabled() && isApproveRequest(text)) {
      void this.review
        .fromApproveMessage({ channelId, threadTs: replyThreadTs /* or threadTs at :843 */, userId, text })
        .catch((e) => this.log(`approve: ${(e as Error).message}`));
      return;
    }
```
Update the import at `:58`:
```typescript
import { ReviewCoordinator, realReviewGateway, isReviewRequest, isRetryRequest, isApproveRequest } from "./review";
```
At the reaction site (`:1013` area), if the reaction emoji is `a`, call `fromApproveReaction` instead of `fromReaction` (match the emoji name the handler already switches on).

- [ ] **Step 2: Verify build + full suite**

Run: `npm --prefix packages/cli run build && npm --prefix packages/cli test`
Expected: build clean, all tests PASS.

- [ ] **Step 3: Document**

Add a short section to `README.md` (near the `:cr:` docs): `:a: <PR url>` → fast single-agent review, approves iff no CRITICAL/HIGH; and `review.allowApprove` config (default false) for `:cr:` real-approve.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/gateway/slack/index.ts README.md
git commit -m "feat(review): route :a: approve command + docs"
```

---

## Self-Review

- **Spec coverage:** Item 1 → Tasks 1,3,4. Item 2 → Tasks 5,6,7. Item 3a → Tasks 2,9,10,11. Item 3b → Task 8. Strategy widening → Task 2. All spec sections covered.
- **Placeholders:** none — every step has concrete code/commands. The one soft spot (Task 10 "copy the prelude") is a deliberate, explained design call, not a TODO.
- **Type consistency:** `ReviewStrategy` (Task 2) used by `buildReviewArgv`/`reviewEnv`/`runMraReview`/`ReviewProgress`. `allowApprove`/`approveIfNoHigh` names identical across config, args, env. `finish`/`dispose`/`onLine` consistent between Task 6 defs and Task 7/10 calls.
- **Cross-repo order:** Task 8 (mra, PR B) must land or its env contract be fixed before Task 11 enables `:a:` in production; Tasks 1–7 are independent.

## Verification (post-implementation, before merge)

- Live: `:cr: <private PR url>` → progress bar animates, never freezes, ends on the result line. With `review.allowApprove: true`, an approvable PR shows `APPROVED` on GitHub (not `COMMENTED`).
- Live: `:a: <clean private PR url>` → `已 approve`; `:a: <PR with a HIGH issue>` → `未 approve` + CHANGES_REQUESTED on GitHub.
- Use `superpowers:verification-before-completion` before claiming done.

