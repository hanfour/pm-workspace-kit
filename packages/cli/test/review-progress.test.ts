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
