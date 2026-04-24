import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { pLimit } from "../src/concurrency";

describe("pLimit", () => {
  it("preserves input order in results", async () => {
    const out = await pLimit([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    assert.deepEqual(out, [10, 20, 30, 40, 50]);
  });

  it("never exceeds the concurrency limit", async () => {
    let running = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await pLimit(items, 3, async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    });
    assert.ok(peak <= 3, `peak was ${peak}, expected ≤ 3`);
  });

  it("handles empty input without spawning workers", async () => {
    const out = await pLimit([], 3, async () => {
      throw new Error("should not run");
    });
    assert.deepEqual(out, []);
  });

  it("clamps NaN / Infinity / negative limit to 1 (no silent skip)", async () => {
    for (const bad of [NaN, Infinity, -Infinity, -5, parseInt("abc", 10)]) {
      const out = await pLimit([1, 2, 3], bad, async (n) => n * 2);
      assert.deepEqual(
        out,
        [2, 4, 6],
        `expected all tasks to run for limit=${bad}`,
      );
    }
  });

  it("clamps limit < 1 to 1", async () => {
    let running = 0;
    let peak = 0;
    await pLimit([1, 2, 3], 0, async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    });
    assert.equal(peak, 1);
  });

  it("propagates worker errors", async () => {
    await assert.rejects(
      pLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
      /boom/,
    );
  });
});
