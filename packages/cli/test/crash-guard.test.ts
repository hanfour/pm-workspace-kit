import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  describeRejection,
  installUnhandledRejectionGuard,
  makeRejectionHandler,
} from "../src/gateway/crash-guard";

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
});
