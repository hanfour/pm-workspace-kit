import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendGatewayEvent, readGatewayEvents } from "../src/gateway/events";

describe("github issue events", () => {
  let home: string;
  const orig = process.env.HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-ghev-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    if (orig !== undefined) process.env.HOME = orig;
  });

  it("round-trips created + failed through the reader", () => {
    appendGatewayEvent({
      type: "github.issue.created",
      actor: "U-IT",
      repo: "o/r",
      url: "https://github.com/o/r/issues/7",
    });
    appendGatewayEvent({
      type: "github.issue.failed",
      actor: "U-IT",
      reason: "no-gh",
    });
    const evs = readGatewayEvents();
    const types = evs.map((e) => e.type);
    assert.ok(types.includes("github.issue.created"));
    assert.ok(types.includes("github.issue.failed"));
  });
});
