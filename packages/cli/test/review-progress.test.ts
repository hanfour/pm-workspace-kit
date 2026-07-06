import { test } from "node:test";
import assert from "node:assert/strict";
import { phaseFromLine, computePct, renderBar } from "../src/gateway/slack/review-progress";

test("phaseFromLine — pkb", () => {
  assert.equal(
    phaseFromLine("[review] PKB available — using knowledge base"),
    "pkb",
  );
});

test("phaseFromLine — analyze", () => {
  assert.equal(
    phaseFromLine("[review] loaded existing PR discussion into review context"),
    "analyze",
  );
});

test("phaseFromLine — analyze fires on the unconditional 'running Claude' line (fresh PR / standard)", () => {
  // review.sh:461 logs this to stdout on every single-pass review, unlike the
  // conditional 'loaded existing PR discussion' line — so a fresh PR still enters
  // analyze instead of freezing at prepare/pkb.
  assert.equal(phaseFromLine("[review] running Claude (sonnet)..."), "analyze");
});

test("phaseFromLine — analyze fires on debate round markers", () => {
  assert.equal(phaseFromLine("[debate] [round 1] independent analysis — 2 agents searching codebase..."), "analyze");
  assert.equal(phaseFromLine("[debate] [final] synthesizing review from debate results..."), "analyze");
});

test("phaseFromLine — posting", () => {
  assert.equal(
    phaseFromLine(
      "[review] posting inline review to onead/superdsp-ui#547 (3 comments)...",
    ),
    "posting",
  );
});

test("phaseFromLine — done", () => {
  assert.equal(
    phaseFromLine("[review] review posted: onead/superdsp-ui#547 (review #1)"),
    "done",
  );
});

test("phaseFromLine — unrelated line", () => {
  assert.equal(phaseFromLine("some unrelated line"), undefined);
});

test("computePct — analyze at t=0 returns floor", () => {
  assert.equal(computePct("analyze", 0, "debate"), 35);
});

test("computePct — analyze with elapsed creeps above floor but stays <= cap", () => {
  const pct = computePct("analyze", 10 * 60_000, "debate");
  assert.ok(pct > 35, `expected > 35, got ${pct}`);
  assert.ok(pct <= 85, `expected <= 85, got ${pct}`);
});

test("computePct — done returns 100", () => {
  assert.equal(computePct("done", 0, "debate"), 100);
});

test("computePct — posting returns 90", () => {
  assert.equal(computePct("posting", 0, "debate"), 90);
});

test("computePct — prepare returns 5", () => {
  assert.equal(computePct("prepare", 0, "debate"), 5);
});

test("renderBar — correct format with glyphs", () => {
  assert.equal(
    renderBar(60, "分析中(debate)", ":mag: review #547"),
    ":mag: review #547\n▰▰▰▱▱ 60%\n目前:分析中(debate)",
  );
});

import { ReviewProgress } from "../src/gateway/slack/review-progress";

function fakeWeb() {
  const updates: string[] = [];
  return { updates, web: { chat: { update: async ({ text }: any) => { updates.push(text); return {}; } } } };
}

test("updates only when render changes; finish converges to final text", async () => {
  let clock = 0;
  const timers: Array<() => void> = [];
  const { web, updates } = fakeWeb();
  const p = new ReviewProgress({
    web: web as any, channel: "C", ts: "1", strategy: "standard", headline: ":mag: review #547",
    now: () => clock,
    setTimer: (fn: () => void) => { timers.push(fn); return 1 as any; },
    clearTimer: () => {},
  });
  p.onLine("[review] loaded existing PR discussion into review context"); // → analyze, floor 35
  timers[0]();                        // tick at clock 0
  clock = 90_000; timers[0]();        // tick later → pct creeps up (new render)
  const n = updates.length;
  timers[0]();                        // same clock → no new update
  assert.equal(updates.length, n);
  await p.finish(":white_check_mark: 已 approve #547");
  assert.equal(updates[updates.length - 1], ":white_check_mark: 已 approve #547");
});

const flush = () => new Promise((r) => setImmediate(r));

test("auto-advances prepare→analyze after the setup budget (fresh PR: no PKB/discussion, debate markers on stderr) (M4)", async () => {
  let clock = 0;
  const timers: Array<() => void> = [];
  const { web, updates } = fakeWeb();
  const p = new ReviewProgress({
    web: web as any, channel: "C", ts: "1", strategy: "standard", headline: ":mag: review #7",
    now: () => clock,
    setTimer: (fn: () => void) => { timers.push(fn); return 1 as any; },
    clearTimer: () => {},
  });
  // No onLine marker ever arrives; time passes past the setup budget while in prepare.
  clock = 25_000;
  timers[0]();
  await flush();
  assert.ok(
    updates.some((u) => u.includes("分析中")),
    `bar must advance to analyze after the setup budget, got: ${JSON.stringify(updates)}`,
  );
  p.dispose();
});

test("a failed chat.update does not commit dedupe state — an identical render retries, and the failure is logged (M6a/M6c)", async () => {
  let clock = 0, calls = 0;
  const timers: Array<() => void> = [];
  const logs: string[] = [];
  const web = { chat: { update: async () => { calls++; throw new Error("slack hiccup"); } } };
  const p = new ReviewProgress({
    web: web as any, channel: "C", ts: "1", strategy: "standard", headline: "h",
    now: () => clock,
    setTimer: (fn: () => void) => { timers.push(fn); return 1 as any; },
    clearTimer: () => {},
    onLog: (m: string) => logs.push(m),
  });
  p.onLine("[review] running Claude (sonnet)..."); // → analyze, triggers a tick that fails
  await flush();
  const after1 = calls;
  timers[0](); // same clock + same render → must RETRY because the prior update failed
  await flush();
  assert.ok(calls > after1, "an identical render must retry after a failed update (dedupe not committed on failure)");
  assert.ok(logs.some((l) => /progress update failed/.test(l)), "a failed progress update must be logged");
  p.dispose();
});

test("a stale progress tick fired after finish() does not overwrite the final result (M6b)", async () => {
  let clock = 0;
  const timers: Array<() => void> = [];
  const { web, updates } = fakeWeb();
  const p = new ReviewProgress({
    web: web as any, channel: "C", ts: "1", strategy: "standard", headline: ":mag: review #7",
    now: () => clock,
    setTimer: (fn: () => void) => { timers.push(fn); return 1 as any; },
    clearTimer: () => {},
  });
  p.onLine("[review] running Claude (sonnet)..."); // analyze
  clock = 30_000;
  await p.finish(":white_check_mark: 已 approve #7");
  timers[0](); // a stale interval tick fires AFTER finish
  await flush();
  assert.equal(
    updates[updates.length - 1],
    ":white_check_mark: 已 approve #7",
    "the final result must remain the last update; a stale tick must not clobber it",
  );
  p.dispose();
});

test("dispose clears the timer", () => {
  let cleared = 0;
  const { web } = fakeWeb();
  const p = new ReviewProgress({
    web: web as any, channel: "C", ts: "1", strategy: "debate", headline: "h",
    now: () => 0, setTimer: () => 7 as any, clearTimer: () => { cleared++; },
  });
  p.dispose();
  assert.equal(cleared, 1);
});
