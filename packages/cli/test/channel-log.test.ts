/**
 * Unit coverage for the v0.13 append-only channel message log.
 * Three groups: (1) basic round-trip + filter options,
 * (2) race-freedom under simulated concurrent appends,
 * (3) one-time migration from the legacy `chat-session.json`.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendChannelTurns,
  entriesToMessages,
  loadChannelTurns,
  type ChannelLogEntry,
} from "../src/gateway/channel-log";

// Never point HOME back at the operator's home. Test files run in separate
// processes, so restoring buys nothing — and it opens a window that has
// already caused an outage: a cancelled test's abandoned continuation resumes
// AFTER afterEach, sees the real HOME, and writes to the live ~/.pmk. On
// 2026-08-04 that overwrote the gateway config with test fixtures and took
// the bot down. ORIG_HOME is a throwaway directory, never the real one.
const ORIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-safe-home-"));
process.env.HOME = ORIG_HOME;

function isoOffset(seconds: number): string {
  return new Date(Date.UTC(2026, 4, 19, 10, 0, seconds)).toISOString();
}

describe("channel-log: round-trip + filters", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-chlog-rt-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env.HOME = ORIG_HOME;
  });

  it("append → load returns entries in write order", () => {
    appendChannelTurns("C-A", undefined, [
      { ts: isoOffset(0), role: "user", userId: "U-1", content: "hello" },
      { ts: isoOffset(1), role: "assistant", content: "hi" },
    ]);
    appendChannelTurns("C-A", undefined, [
      { ts: isoOffset(2), role: "user", userId: "U-2", content: "again" },
      { ts: isoOffset(3), role: "assistant", content: "ack" },
    ]);

    const all = loadChannelTurns("C-A");
    assert.equal(all.length, 4);
    assert.deepEqual(
      all.map((e) => e.content),
      ["hello", "hi", "again", "ack"],
    );
    assert.equal(all[0].userId, "U-1");
    assert.equal(all[2].userId, "U-2");
    assert.equal(all[1].userId, undefined);
  });

  it("threadTs scopes the log to a sub-directory", () => {
    appendChannelTurns("C-A", "1700.0001", [
      { ts: isoOffset(0), role: "user", userId: "U-1", content: "thread Q" },
    ]);
    appendChannelTurns("C-A", undefined, [
      { ts: isoOffset(0), role: "user", userId: "U-1", content: "top-level Q" },
    ]);

    const top = loadChannelTurns("C-A");
    const inThread = loadChannelTurns("C-A", "1700.0001");
    assert.equal(top.length, 1);
    assert.equal(top[0].content, "top-level Q");
    assert.equal(inThread.length, 1);
    assert.equal(inThread[0].content, "thread Q");
  });

  it("limit returns the most-recent N entries", () => {
    const entries: ChannelLogEntry[] = Array.from({ length: 10 }, (_, i) => ({
      ts: isoOffset(i),
      role: i % 2 === 0 ? "user" : "assistant",
      content: `m${i}`,
      ...(i % 2 === 0 ? { userId: `U-${i}` } : {}),
    }));
    appendChannelTurns("C-A", undefined, entries);
    const last3 = loadChannelTurns("C-A", undefined, { limit: 3 });
    assert.deepEqual(
      last3.map((e) => e.content),
      ["m7", "m8", "m9"],
    );
  });

  it("malformed lines are silently skipped (single bad write must not poison the audit)", () => {
    appendChannelTurns("C-A", undefined, [
      { ts: isoOffset(0), role: "user", content: "good" },
    ]);
    const file = path.join(
      tmpHome,
      ".pmk",
      "gateway",
      "slack",
      "channels",
      "C-A",
      "messages.jsonl",
    );
    fs.appendFileSync(file, "not-json-at-all\n", "utf8");
    fs.appendFileSync(
      file,
      JSON.stringify({ ts: isoOffset(2), role: "user", content: "also good" }) +
        "\n",
      "utf8",
    );

    const all = loadChannelTurns("C-A");
    assert.equal(all.length, 2, "two valid entries; the malformed line dropped");
    assert.equal(all[0].content, "good");
    assert.equal(all[1].content, "also good");
  });

  it("entriesToMessages drops metadata, keeps role + content", () => {
    const entries: ChannelLogEntry[] = [
      { ts: isoOffset(0), role: "user", userId: "U-1", content: "q1" },
      { ts: isoOffset(1), role: "assistant", content: "a1" },
    ];
    const msgs = entriesToMessages(entries);
    assert.deepEqual(msgs, [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ]);
  });
});

describe("channel-log: race-free under concurrent appends", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-chlog-race-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env.HOME = ORIG_HOME;
  });

  it("20 parallel appends from 4 simulated users all persist (no last-write-wins drop)", async () => {
    // The pre-v0.13 ChannelChatSession model would have lost
    // entries here: each "user" loaded the same snapshot, pushed,
    // and saved → last write wins. With appendFileSync each call
    // is atomic so all 20 entries must land in the JSONL.
    const users = ["U-A", "U-B", "U-C", "U-D"];
    const tasks = users.flatMap((u, ui) =>
      Array.from({ length: 5 }, (_, i) => async () => {
        appendChannelTurns("C-RACE", undefined, [
          {
            ts: isoOffset(ui * 5 + i),
            role: "user",
            userId: u,
            content: `${u} msg ${i}`,
          },
          {
            ts: isoOffset(ui * 5 + i),
            role: "assistant",
            content: `${u} reply ${i}`,
          },
        ]);
      }),
    );
    await Promise.all(tasks.map((t) => t()));

    const all = loadChannelTurns("C-RACE");
    assert.equal(
      all.length,
      40,
      "every parallel write must land (20 turns × 2 entries each)",
    );
    // Each user has exactly 5 user-role entries on disk.
    for (const u of users) {
      const userEntries = all.filter(
        (e) => e.role === "user" && e.userId === u,
      );
      assert.equal(userEntries.length, 5, `${u} kept all 5 entries`);
    }
  });
});

describe("channel-log: migration from legacy chat-session.json", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-chlog-mig-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env.HOME = ORIG_HOME;
  });

  function writeLegacy(
    channelId: string,
    threadTs: string | undefined,
    messages: Array<{ role: string; content: string }>,
    lastActiveAt: number,
  ): string {
    const base = path.join(
      tmpHome,
      ".pmk",
      "gateway",
      "slack",
      "channels",
      channelId,
    );
    const dir = threadTs ? path.join(base, "threads", threadTs) : base;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "chat-session.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        channelId,
        messages,
        lastActiveAt,
        approxTokens: 0,
        turns: messages.length / 2,
      }),
      "utf8",
    );
    return file;
  }

  it("first load converts legacy chat-session.json to JSONL, then deletes the old file", () => {
    const oldFile = writeLegacy(
      "C-MIG",
      undefined,
      [
        { role: "user", content: "legacy q1" },
        { role: "assistant", content: "legacy a1" },
        { role: "user", content: "legacy q2" },
        { role: "assistant", content: "legacy a2" },
      ],
      Date.parse("2026-05-10T12:00:00Z"),
    );

    const entries = loadChannelTurns("C-MIG");
    assert.equal(entries.length, 4, "all legacy messages migrated");
    assert.equal(entries[0].content, "legacy q1");
    assert.equal(entries[3].content, "legacy a2");

    assert.equal(
      fs.existsSync(oldFile),
      false,
      "legacy chat-session.json removed after migration",
    );

    // Second load should be migration-free (no chat-session.json exists)
    // and still return the same entries.
    const second = loadChannelTurns("C-MIG");
    assert.deepEqual(
      second.map((e) => e.content),
      entries.map((e) => e.content),
    );
  });

  it("migration is idempotent — running load when only JSONL exists is a no-op", () => {
    appendChannelTurns("C-NM", undefined, [
      { ts: isoOffset(0), role: "user", content: "native" },
    ]);

    // No legacy file present; load should not blow up or duplicate.
    const entries = loadChannelTurns("C-NM");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].content, "native");
  });

  it("legacy file with malformed messages array → migration leaves entries empty, deletes nothing", () => {
    const base = path.join(
      tmpHome,
      ".pmk",
      "gateway",
      "slack",
      "channels",
      "C-BAD",
    );
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(
      path.join(base, "chat-session.json"),
      "{this-is-not-json",
      "utf8",
    );

    const entries = loadChannelTurns("C-BAD");
    assert.equal(entries.length, 0);
    // Legacy file remained because conversion failed — operator
    // can investigate. The JSONL was never created.
    assert.equal(
      fs.existsSync(path.join(base, "chat-session.json")),
      true,
      "malformed legacy file is preserved for manual inspection",
    );
    assert.equal(
      fs.existsSync(path.join(base, "messages.jsonl")),
      false,
      "no JSONL was written from a failed migration",
    );
  });
});
