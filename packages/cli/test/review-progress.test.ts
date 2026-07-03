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
