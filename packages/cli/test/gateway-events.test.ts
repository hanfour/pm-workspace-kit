import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ORIG_HOME = process.env.HOME;

describe("gateway events log (#24)", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-gw-events-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  it("appendGatewayEvent → readGatewayEvents round-trips a turn.processed event", async () => {
    const { appendGatewayEvent, readGatewayEvents } =
      await import("../src/gateway/events");
    appendGatewayEvent({
      type: "turn.processed",
      actor: "U_X",
      audience: "tech",
      hadMraAsk: false,
      atomsInjected: 0,
    });
    const entries = readGatewayEvents();
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.equal(e.type, "turn.processed");
    if (e.type === "turn.processed") {
      assert.equal(e.actor, "U_X");
      assert.equal(e.audience, "tech");
      assert.equal(e.atomsInjected, 0);
    }
    assert.ok(typeof e.at === "string" && e.at.length > 0);
  });

  it("supports all four event types via the discriminated union", async () => {
    const { appendGatewayEvent, readGatewayEvents } =
      await import("../src/gateway/events");
    appendGatewayEvent({
      type: "mra-ask.end",
      actor: "U_X",
      repo: "erp",
      ok: true,
      retried: false,
      durationMs: 42_000,
    });
    appendGatewayEvent({
      type: "turn.processed",
      actor: "U_X",
      audience: "biz",
      hadMraAsk: true,
      atomsInjected: 2,
    });
    appendGatewayEvent({
      type: "escalate.triggered",
      channelId: "C0X",
      threadTs: "1234.5678",
      scope: "erp",
    });
    appendGatewayEvent({
      type: "escalate.absorbed",
      channelId: "C0X",
      threadTs: "1234.5678",
      atomId: "atom-abc",
    });
    const entries = readGatewayEvents();
    assert.equal(entries.length, 4);
    assert.deepEqual(
      entries.map((e) => e.type),
      [
        "mra-ask.end",
        "turn.processed",
        "escalate.triggered",
        "escalate.absorbed",
      ],
    );
  });

  it("readGatewayEvents returns [] when file missing", async () => {
    const { readGatewayEvents } = await import("../src/gateway/events");
    assert.deepEqual(readGatewayEvents(), []);
  });

  it("malformed lines are skipped, well-formed lines still parse", async () => {
    const { appendGatewayEvent, readGatewayEvents, gatewayEventsPath } =
      await import("../src/gateway/events");
    appendGatewayEvent({
      type: "turn.processed",
      actor: "U_A",
      audience: "tech",
      hadMraAsk: false,
      atomsInjected: 0,
    });
    fs.appendFileSync(gatewayEventsPath(), "not json at all\n");
    appendGatewayEvent({
      type: "turn.processed",
      actor: "U_B",
      audience: "pm",
      hadMraAsk: false,
      atomsInjected: 0,
    });
    const entries = readGatewayEvents();
    assert.equal(entries.length, 2);
    assert.equal(
      entries[0].type === "turn.processed" && entries[0].actor,
      "U_A",
    );
    assert.equal(
      entries[1].type === "turn.processed" && entries[1].actor,
      "U_B",
    );
  });

  it("readGatewayEvents filters by sinceMs (inclusive)", async () => {
    const { appendGatewayEvent, readGatewayEvents, gatewayEventsPath } =
      await import("../src/gateway/events");
    // Write events with explicit `at` timestamps by writing raw lines.
    const old = JSON.stringify({
      at: "2026-04-20T00:00:00.000Z",
      type: "turn.processed",
      actor: "U_OLD",
      audience: "tech",
      hadMraAsk: false,
      atomsInjected: 0,
    });
    const recent = JSON.stringify({
      at: "2026-04-29T00:00:00.000Z",
      type: "turn.processed",
      actor: "U_NEW",
      audience: "tech",
      hadMraAsk: false,
      atomsInjected: 0,
    });
    fs.mkdirSync(path.dirname(gatewayEventsPath()), { recursive: true });
    fs.writeFileSync(gatewayEventsPath(), `${old}\n${recent}\n`, "utf8");

    const cutoff = Date.parse("2026-04-25T00:00:00.000Z");
    const entries = readGatewayEvents({ sinceMs: cutoff });
    assert.equal(entries.length, 1);
    assert.equal(
      entries[0].type === "turn.processed" && entries[0].actor,
      "U_NEW",
    );
    // appendGatewayEvent on top of the seeded file
    appendGatewayEvent({
      type: "turn.processed",
      actor: "U_NOW",
      audience: "biz",
      hadMraAsk: false,
      atomsInjected: 0,
    });
    const all = readGatewayEvents();
    assert.equal(all.length, 3);
  });

  it("readGatewayEvents tails to limit (newest last)", async () => {
    const { appendGatewayEvent, readGatewayEvents } =
      await import("../src/gateway/events");
    for (let i = 0; i < 30; i++) {
      appendGatewayEvent({
        type: "turn.processed",
        actor: `U_${i}`,
        audience: "tech",
        hadMraAsk: false,
        atomsInjected: 0,
      });
    }
    const tail = readGatewayEvents({ limit: 5 });
    assert.equal(tail.length, 5);
    assert.equal(
      tail[0].type === "turn.processed" && tail[0].actor,
      "U_25",
    );
    assert.equal(
      tail[4].type === "turn.processed" && tail[4].actor,
      "U_29",
    );
  });

  it("appendGatewayEvent does not throw if the directory is unwritable (best-effort)", async () => {
    const { appendGatewayEvent } = await import("../src/gateway/events");
    // Point HOME at a path that contains a regular file where the
    // gateway dir would go — mkdir will fail. The append must swallow.
    const blocking = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-block-evt-"));
    fs.writeFileSync(path.join(blocking, ".pmk"), "not a directory");
    process.env.HOME = blocking;
    assert.doesNotThrow(() =>
      appendGatewayEvent({
        type: "turn.processed",
        actor: "U_X",
        audience: "tech",
        hadMraAsk: false,
        atomsInjected: 0,
      }),
    );
    fs.rmSync(blocking, { recursive: true, force: true });
  });

  // v0.10.x: monthly partitioning + legacy fallback.

  it("appendGatewayEvent writes to a YYYY-MM partition file, not the legacy events.log", async () => {
    const { appendGatewayEvent, gatewayEventsPath } = await import(
      "../src/gateway/events"
    );
    appendGatewayEvent({
      type: "turn.processed",
      actor: "U_PART",
      audience: "tech",
      hadMraAsk: false,
      atomsInjected: 0,
    });
    const partition = gatewayEventsPath();
    assert.match(
      path.basename(partition),
      /^events-\d{4}-\d{2}\.log$/,
      "current-month partition path should be events-YYYY-MM.log",
    );
    assert.ok(fs.existsSync(partition), "partition file should be created");
    const legacy = path.join(tmpHome, ".pmk", "gateway", "events.log");
    assert.ok(
      !fs.existsSync(legacy),
      "legacy events.log should NOT be written by v0.10.x and beyond",
    );
  });

  it("readGatewayEvents merges legacy events.log with the current-month partition", async () => {
    const { appendGatewayEvent, readGatewayEvents } = await import(
      "../src/gateway/events"
    );
    const gatewayDir = path.join(tmpHome, ".pmk", "gateway");
    fs.mkdirSync(gatewayDir, { recursive: true });
    const legacy = path.join(gatewayDir, "events.log");
    fs.writeFileSync(
      legacy,
      JSON.stringify({
        at: new Date().toISOString(),
        type: "turn.processed",
        actor: "U_LEGACY",
        audience: "tech",
        hadMraAsk: false,
        atomsInjected: 0,
      }) + "\n",
    );
    appendGatewayEvent({
      type: "turn.processed",
      actor: "U_NEW",
      audience: "tech",
      hadMraAsk: false,
      atomsInjected: 0,
    });
    const entries = readGatewayEvents();
    assert.equal(entries.length, 2);
    assert.equal(
      entries[0].type === "turn.processed" && entries[0].actor,
      "U_LEGACY",
    );
    assert.equal(
      entries[1].type === "turn.processed" && entries[1].actor,
      "U_NEW",
    );
  });

  it("readGatewayEvents reads across multiple month partitions and respects sinceMs", async () => {
    const { readGatewayEvents } = await import("../src/gateway/events");
    const { monthlyPath } = await import("../src/gateway/monthly-jsonl");
    const gatewayDir = path.join(tmpHome, ".pmk", "gateway");
    fs.mkdirSync(gatewayDir, { recursive: true });
    const now = new Date();
    const twoMonthsAgo = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 15),
    );
    const oneMonthAgo = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15),
    );
    const writeAt = (file: string, ts: Date, actor: string) => {
      fs.writeFileSync(
        file,
        JSON.stringify({
          at: ts.toISOString(),
          type: "turn.processed",
          actor,
          audience: "tech",
          hadMraAsk: false,
          atomsInjected: 0,
        }) + "\n",
      );
    };
    writeAt(monthlyPath(gatewayDir, "events", twoMonthsAgo), twoMonthsAgo, "U_OLD");
    writeAt(monthlyPath(gatewayDir, "events", oneMonthAgo), oneMonthAgo, "U_RECENT");
    writeAt(monthlyPath(gatewayDir, "events", now), now, "U_TODAY");

    const all = readGatewayEvents();
    const actors = all
      .filter((e) => e.type === "turn.processed")
      .map((e) => e.type === "turn.processed" && e.actor)
      .filter(Boolean);
    assert.deepEqual(actors, ["U_OLD", "U_RECENT", "U_TODAY"]);

    const cutoff = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
    ).getTime();
    const recent = readGatewayEvents({ sinceMs: cutoff });
    const recentActors = recent
      .filter((e) => e.type === "turn.processed")
      .map((e) => e.type === "turn.processed" && e.actor)
      .filter(Boolean);
    assert.deepEqual(recentActors, ["U_RECENT", "U_TODAY"]);
  });

  // Review-prep for PR #47.

  it("default no-sinceMs read covers ~12 months back; older partitions are skipped", async () => {
    const { readJsonl, monthlyPath } = await import(
      "../src/gateway/monthly-jsonl"
    );
    const gatewayDir = path.join(tmpHome, ".pmk", "gateway");
    fs.mkdirSync(gatewayDir, { recursive: true });
    const now = new Date();
    const longAgo = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 13, 15),
    );
    const recently = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15),
    );
    const writeAt = (file: string, ts: Date, marker: string) => {
      fs.writeFileSync(
        file,
        JSON.stringify({ at: ts.toISOString(), kind: "test", marker }) + "\n",
      );
    };
    writeAt(monthlyPath(gatewayDir, "events", longAgo), longAgo, "TOO_OLD");
    writeAt(monthlyPath(gatewayDir, "events", recently), recently, "IN_WINDOW");

    const isTestEntry = (v: unknown): v is { kind: string; marker: string } => {
      const o = v as Record<string, unknown>;
      return (
        !!o &&
        typeof o === "object" &&
        o.kind === "test" &&
        typeof o.marker === "string"
      );
    };
    const got = readJsonl(gatewayDir, "events", isTestEntry);
    const markers = got.map((e) => e.marker);
    assert.ok(
      markers.includes("IN_WINDOW"),
      "in-window partition should be read",
    );
    assert.ok(
      !markers.includes("TOO_OLD"),
      "13-month-old partition should be skipped under the 12-month default",
    );

    const everything = readJsonl(gatewayDir, "events", isTestEntry, {
      maxMonthsBack: 24,
    });
    const allMarkers = everything.map((e) => e.marker);
    assert.ok(allMarkers.includes("TOO_OLD"));
    assert.ok(allMarkers.includes("IN_WINDOW"));
  });

  it("legacy events.log with mixed valid + malformed lines: malformed are skipped, valid still parse", async () => {
    const { readGatewayEvents } = await import("../src/gateway/events");
    const gatewayDir = path.join(tmpHome, ".pmk", "gateway");
    fs.mkdirSync(gatewayDir, { recursive: true });
    const legacy = path.join(gatewayDir, "events.log");
    const valid = JSON.stringify({
      at: new Date().toISOString(),
      type: "turn.processed",
      actor: "U_VALID_LEGACY",
      audience: "tech",
      hadMraAsk: false,
      atomsInjected: 0,
    });
    fs.writeFileSync(
      legacy,
      [
        valid,
        "this is not json — a partial write from a crashed process",
        '{"truncated":',
        valid.replace("U_VALID_LEGACY", "U_VALID_2"),
      ].join("\n") + "\n",
    );
    const entries = readGatewayEvents();
    assert.equal(entries.length, 2);
    assert.equal(
      entries[0].type === "turn.processed" && entries[0].actor,
      "U_VALID_LEGACY",
    );
    assert.equal(
      entries[1].type === "turn.processed" && entries[1].actor,
      "U_VALID_2",
    );
  });
});
