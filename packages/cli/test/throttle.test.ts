import { describe, it, beforeEach, afterEach, mock } from "node:test";
import * as assert from "node:assert/strict";
import { createLastLineThrottle } from "../src/gateway/throttle";

describe("createLastLineThrottle (#22)", () => {
  let now = 0;
  let scheduled: Array<{ at: number; fn: () => void }> = [];
  let timerId = 0;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;

  beforeEach(() => {
    now = 0;
    scheduled = [];
    timerId = 0;
    // Replace timers with a manual clock so tests don't actually wait.
    (globalThis as { setTimeout: unknown }).setTimeout = ((
      fn: () => void,
      delayMs: number,
    ) => {
      timerId += 1;
      const id = timerId;
      scheduled.push({ at: now + delayMs, fn });
      return { _mockId: id } as unknown as NodeJS.Timeout;
    }) as typeof setTimeout;
    (globalThis as { clearTimeout: unknown }).clearTimeout = ((
      handle: { _mockId: number } | undefined,
    ) => {
      if (!handle) return;
      scheduled = scheduled.filter((s) => {
        // Match by reference to the timer id; the stub above wraps id
        // inside the returned handle.
        return (
          (s.fn as { _mockId?: number })._mockId === undefined ||
          (s.fn as { _mockId?: number })._mockId !== handle._mockId
        );
      });
    }) as typeof clearTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  });

  function advance(ms: number): void {
    now += ms;
    const due = scheduled.filter((s) => s.at <= now);
    scheduled = scheduled.filter((s) => s.at > now);
    for (const d of due) d.fn();
  }

  it("first push fires immediately (leading edge)", () => {
    const onFire = mock.fn<(line: string) => void>();
    const t = createLastLineThrottle({ windowMs: 3000, onFire });
    t.push("first");
    assert.equal(onFire.mock.callCount(), 1);
    assert.equal(onFire.mock.calls[0].arguments[0], "first");
  });

  it("pushes within the window are coalesced; only last line fires at window end", () => {
    const onFire = mock.fn<(line: string) => void>();
    const t = createLastLineThrottle({ windowMs: 3000, onFire });
    t.push("a"); // leading-fire
    t.push("b");
    t.push("c");
    advance(2999);
    assert.equal(onFire.mock.callCount(), 1, "still in window — no trailing yet");
    advance(2);
    assert.equal(onFire.mock.callCount(), 2);
    assert.equal(onFire.mock.calls[1].arguments[0], "c");
  });

  it("trailing fire is suppressed when no new line arrived after the leading fire", () => {
    const onFire = mock.fn<(line: string) => void>();
    const t = createLastLineThrottle({ windowMs: 3000, onFire });
    t.push("only");
    advance(5000);
    assert.equal(onFire.mock.callCount(), 1, "no new line → no redundant trailing");
  });

  it("trailing fire is suppressed when the latest line equals the last-fired line", () => {
    const onFire = mock.fn<(line: string) => void>();
    const t = createLastLineThrottle({ windowMs: 3000, onFire });
    t.push("same");
    t.push("same");
    advance(5000);
    assert.equal(onFire.mock.callCount(), 1);
  });

  it("after the trailing fire, the next push starts a new leading fire", () => {
    const onFire = mock.fn<(line: string) => void>();
    const t = createLastLineThrottle({ windowMs: 3000, onFire });
    t.push("a");
    t.push("b");
    advance(3001); // trailing fires "b"
    assert.equal(onFire.mock.callCount(), 2);
    t.push("c"); // out of cooldown → leading fires immediately
    assert.equal(onFire.mock.callCount(), 3);
    assert.equal(onFire.mock.calls[2].arguments[0], "c");
  });

  it("cancel() prevents the trailing fire", () => {
    const onFire = mock.fn<(line: string) => void>();
    const t = createLastLineThrottle({ windowMs: 3000, onFire });
    t.push("a");
    t.push("b");
    t.cancel();
    advance(5000);
    assert.equal(onFire.mock.callCount(), 1, "only leading; trailing cancelled");
  });

  it("onFire failures are swallowed so a bad sink doesn't break the producer", () => {
    const onFire = mock.fn<(line: string) => void>(() => {
      throw new Error("network down");
    });
    const t = createLastLineThrottle({ windowMs: 3000, onFire });
    assert.doesNotThrow(() => t.push("a"));
    t.push("b");
    assert.doesNotThrow(() => advance(3001));
  });
});
