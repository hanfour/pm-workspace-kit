import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  describeRejection,
  installUncaughtExceptionGuard,
  installUnhandledRejectionGuard,
  makeRejectionHandler,
  makeUncaughtExceptionHandler,
} from "../src/gateway/crash-guard";
import type { GatewayEvent } from "../src/gateway/events";

describe("describeRejection", () => {
  it("formats an Error", () => {
    assert.equal(describeRejection(new TypeError("boom")), "TypeError: boom");
  });
  it("formats undefined/null with the socket-mode hint", () => {
    assert.match(describeRejection(undefined), /undefined.*socket-mode/);
    assert.match(describeRejection(null), /null.*socket-mode/);
  });
  it("formats a string + an object", () => {
    assert.equal(describeRejection("nope"), "nope");
    assert.equal(describeRejection({ a: 1 }), '{"a":1}');
  });
});

describe("installUnhandledRejectionGuard", () => {
  it("registers a listener and the disposer removes it", () => {
    const before = process.listenerCount("unhandledRejection");
    const dispose = installUnhandledRejectionGuard(() => {});
    assert.equal(process.listenerCount("unhandledRejection"), before + 1);
    dispose();
    assert.equal(process.listenerCount("unhandledRejection"), before);
  });

  it("the handler logs + survives the undefined-reason (socket-mode) case", () => {
    // Direct handler test — a REAL unhandled rejection can't be tested inside
    // node:test (the runner attributes any real rejection to the test as a
    // failure, regardless of our handler). Registering the listener is what
    // suppresses Node's crash (covered by the test above); here we verify the
    // handler itself logs + doesn't throw on the exact reason we saw live.
    const logs: string[] = [];
    const handler = makeRejectionHandler((m) => logs.push(m));
    assert.doesNotThrow(() => handler(undefined));
    assert.ok(
      logs.some((l) => /\[unhandledRejection\] survived.*socket-mode/.test(l)),
      "handler must log the survived rejection",
    );
  });

  // A log line reaches only the operator's terminal. `pmk gateway audit`,
  // doctor, and any events tailer read the event stream — so a guard that
  // only logs leaves them blind to the very failures it intercepts.
  it("emits a non-fatal gateway.rejection event so the audit stream sees it", () => {
    const events: GatewayEvent[] = [];
    const handler = makeRejectionHandler(
      () => {},
      (e) => events.push(e),
    );
    handler(new TypeError("boom"));
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.type, "gateway.rejection");
    if (e.type === "gateway.rejection") {
      assert.equal(e.kind, "unhandledRejection");
      assert.equal(e.fatal, false);
      assert.match(e.reason, /TypeError: boom/);
    }
  });

  it("still survives when the event emitter itself throws", () => {
    const logs: string[] = [];
    const handler = makeRejectionHandler(
      (m) => logs.push(m),
      () => {
        throw new Error("disk full");
      },
    );
    assert.doesNotThrow(() => handler(undefined));
    assert.ok(logs.length > 0, "the log line must survive an emitter failure");
  });
});

describe("uncaught-exception guard", () => {
  it("records a FATAL gateway.rejection, then exits non-zero", () => {
    const events: GatewayEvent[] = [];
    const exits: number[] = [];
    const handler = makeUncaughtExceptionHandler(
      () => {},
      (e) => events.push(e),
      (code) => exits.push(code),
    );
    handler(new RangeError("out of range"));
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.type, "gateway.rejection");
    if (e.type === "gateway.rejection") {
      assert.equal(e.kind, "uncaughtException");
      assert.equal(e.fatal, true);
      assert.match(e.reason, /RangeError: out of range/);
      assert.ok(e.stack && e.stack.length > 0, "a fatal crash must carry a stack");
    }
    assert.deepEqual(exits, [1], "must exit non-zero so the supervisor restarts");
  });

  it("exits even when recording the event fails", () => {
    const exits: number[] = [];
    const handler = makeUncaughtExceptionHandler(
      () => {},
      () => {
        throw new Error("disk full");
      },
      (code) => exits.push(code),
    );
    assert.doesNotThrow(() => handler(new Error("boom")));
    assert.deepEqual(exits, [1], "a failed audit write must not block the exit");
  });

  it("registers a listener and the disposer removes it", () => {
    const before = process.listenerCount("uncaughtException");
    const dispose = installUncaughtExceptionGuard(() => {});
    assert.equal(process.listenerCount("uncaughtException"), before + 1);
    dispose();
    assert.equal(process.listenerCount("uncaughtException"), before);
  });
});
