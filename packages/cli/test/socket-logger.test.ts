import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import type { Logger } from "@slack/logger";

function recordingLogger() {
  const lines: Array<{ level: string; msg: string }> = [];
  const base = {
    debug: (...m: unknown[]) => lines.push({ level: "debug", msg: m.join(" ") }),
    info: (...m: unknown[]) => lines.push({ level: "info", msg: m.join(" ") }),
    warn: (...m: unknown[]) => lines.push({ level: "warn", msg: m.join(" ") }),
    error: (...m: unknown[]) => lines.push({ level: "error", msg: m.join(" ") }),
    setLevel: () => {},
    getLevel: () => "warn",
    setName: () => {},
  } as unknown as Logger;
  return { base, lines };
}

describe("createPongTapLogger", () => {
  it("bumps on the real SDK pong/ping-timeout strings and forwards them", async () => {
    const { createPongTapLogger } = await import("../src/gateway/slack/socket-logger");
    const { base, lines } = recordingLogger();
    let bumps = 0;
    const log = createPongTapLogger(() => { bumps += 1; }, base);
    log.warn("A pong wasn't received from the server before the timeout of 5000ms!");
    log.warn("A ping wasn't received from the server before the timeout of 30000ms!");
    assert.equal(bumps, 2);
    assert.equal(lines.filter((l) => l.level === "warn").length, 2);
  });

  it("does not bump on a non-matching warn", async () => {
    const { createPongTapLogger } = await import("../src/gateway/slack/socket-logger");
    const { base, lines } = recordingLogger();
    let bumps = 0;
    const log = createPongTapLogger(() => { bumps += 1; }, base);
    log.warn("some unrelated warning");
    assert.equal(bumps, 0);
    assert.equal(lines.length, 1);
  });

  it("forwards every level to the wrapped logger (observe-only tap)", async () => {
    const { createPongTapLogger } = await import("../src/gateway/slack/socket-logger");
    const { base, lines } = recordingLogger();
    const log = createPongTapLogger(() => {}, base);
    log.debug("d"); log.info("i"); log.warn("w"); log.error("e");
    assert.deepEqual(lines.map((l) => l.level), ["debug", "info", "warn", "error"]);
  });

  it("still forwards the warn line when the tap callback throws", async () => {
    const { createPongTapLogger } = await import("../src/gateway/slack/socket-logger");
    const { base, lines } = recordingLogger();
    const log = createPongTapLogger(() => { throw new Error("boom"); }, base);
    log.warn("A pong wasn't received from the server before the timeout of 5000ms!");
    assert.equal(lines.filter((l) => l.level === "warn").length, 1); // not dropped
  });
});
