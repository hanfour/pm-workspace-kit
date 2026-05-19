/**
 * Unit coverage for the v0.13 InFlightQueue. Adapter-level
 * integration tests live in `slack-adapter.test.ts`; this file
 * pins the queue's contract in isolation.
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  DEFAULT_MAX_DEPTH,
  InFlightQueue,
  QueueFullError,
} from "../src/gateway/slack/inflight-queue";

/** Build a controllable async work fn: returns the fn + resolver. */
function gateWork(): {
  fn: () => Promise<void>;
  release: () => void;
  ran: { count: number };
} {
  let resolveGate: () => void = () => {};
  const gate = new Promise<void>((res) => {
    resolveGate = res;
  });
  const ran = { count: 0 };
  return {
    fn: async () => {
      ran.count++;
      await gate;
    },
    release: () => resolveGate(),
    ran,
  };
}

describe("InFlightQueue: enqueue contract", () => {
  it("enqueue on empty key runs immediately", () => {
    const q = new InFlightQueue();
    const w = gateWork();
    const result = q.enqueue("k", w.fn);
    assert.equal(result, "ran");
    w.release();
  });

  it("enqueue while worker active returns 'queued'", async () => {
    const q = new InFlightQueue();
    const w1 = gateWork();
    const w2 = gateWork();
    assert.equal(q.enqueue("k", w1.fn), "ran");
    // Let w1 enter its first await so the worker is observably active.
    await new Promise((res) => setImmediate(res));
    assert.equal(q.enqueue("k", w2.fn), "queued");
    w1.release();
    w2.release();
    await q.waitIdle("k");
  });

  it("queue at maxDepth throws QueueFullError", async () => {
    const q = new InFlightQueue({ maxDepth: 2 });
    const w = gateWork();
    q.enqueue("k", w.fn); // ran
    await new Promise((res) => setImmediate(res));
    q.enqueue("k", async () => {}); // queued depth=1
    q.enqueue("k", async () => {}); // queued depth=2
    assert.throws(
      () => q.enqueue("k", async () => {}),
      (err: unknown) => {
        if (!(err instanceof QueueFullError)) return false;
        assert.equal(err.key, "k");
        assert.equal(err.depth, 2);
        return true;
      },
    );
    w.release();
    await q.waitIdle("k");
  });

  it("default maxDepth is 3", async () => {
    const q = new InFlightQueue();
    const w = gateWork();
    q.enqueue("k", w.fn);
    await new Promise((res) => setImmediate(res));
    // Queue 3 — at cap.
    q.enqueue("k", async () => {});
    q.enqueue("k", async () => {});
    q.enqueue("k", async () => {});
    assert.equal(q.depth("k"), 3);
    // 4th overflows.
    assert.throws(() => q.enqueue("k", async () => {}), QueueFullError);
    assert.equal(DEFAULT_MAX_DEPTH, 3);
    w.release();
    await q.waitIdle("k");
  });
});

describe("InFlightQueue: FIFO order", () => {
  it("queued work runs in submission order after drain", async () => {
    const q = new InFlightQueue();
    const order: number[] = [];
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((res) => {
      releaseFirst = res;
    });

    q.enqueue("k", async () => {
      await gate;
      order.push(1);
    });
    await new Promise((res) => setImmediate(res));
    q.enqueue("k", async () => {
      order.push(2);
    });
    q.enqueue("k", async () => {
      order.push(3);
    });

    releaseFirst();
    await q.waitIdle("k");

    assert.deepEqual(order, [1, 2, 3]);
  });
});

describe("InFlightQueue: different keys are independent", () => {
  it("two keys' workers run in parallel; one key's queue full doesn't affect the other", async () => {
    const q = new InFlightQueue({ maxDepth: 1 });
    const wa = gateWork();
    const wb = gateWork();
    assert.equal(q.enqueue("a", wa.fn), "ran");
    assert.equal(q.enqueue("b", wb.fn), "ran");
    await new Promise((res) => setImmediate(res));
    // Key "a" can take 1 more; key "b" can take 1 more — independently.
    assert.equal(q.enqueue("a", async () => {}), "queued");
    assert.equal(q.enqueue("b", async () => {}), "queued");
    // Now both keys at cap — adding to either throws.
    assert.throws(() => q.enqueue("a", async () => {}), QueueFullError);
    assert.throws(() => q.enqueue("b", async () => {}), QueueFullError);
    wa.release();
    wb.release();
    await q.waitForAll();
    assert.equal(q.busy("a"), false);
    assert.equal(q.busy("b"), false);
  });
});

describe("InFlightQueue: error handling", () => {
  it("a throwing work item doesn't poison the rest of the queue", async () => {
    const logs: string[] = [];
    const q = new InFlightQueue({ onLog: (m) => logs.push(m) });
    const order: number[] = [];

    q.enqueue("k", async () => {
      throw new Error("boom");
    });
    q.enqueue("k", async () => {
      order.push(2);
    });
    q.enqueue("k", async () => {
      order.push(3);
    });

    await q.waitIdle("k");

    assert.deepEqual(order, [2, 3]);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /boom/);
  });
});

describe("InFlightQueue: waitForAll", () => {
  it("resolves when every active key drains", async () => {
    const q = new InFlightQueue();
    const wa = gateWork();
    const wb = gateWork();
    q.enqueue("a", wa.fn);
    q.enqueue("b", wb.fn);
    await new Promise((res) => setImmediate(res));
    assert.equal(q.busy("a"), true);
    assert.equal(q.busy("b"), true);
    wa.release();
    wb.release();
    await q.waitForAll();
    assert.equal(q.busy("a"), false);
    assert.equal(q.busy("b"), false);
  });

  it("resolves immediately when nothing is running", async () => {
    const q = new InFlightQueue();
    await q.waitForAll();
    assert.equal(q.busy("anything"), false);
  });
});
