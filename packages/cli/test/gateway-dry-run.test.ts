import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { WebClient } from "@slack/web-api";
import {
  createDryRunStats,
  isDryRunActive,
  wrapWebClientForDryRun,
} from "../src/gateway/slack/dry-run-wrapper";
import {
  appendGatewayEvent,
  gatewayEventsPath,
  readGatewayEvents,
} from "../src/gateway/events";

// Minimal WebClient fake — just the surface the proxy will touch.
class WriteRecorder {
  posted: unknown[] = [];
  ephemeral: unknown[] = [];
  updated: unknown[] = [];
  deleted: unknown[] = [];
  reactionsAdded: unknown[] = [];
  reactionsRemoved: unknown[] = [];
  viewsOpened: unknown[] = [];
  filesUploaded: unknown[] = [];
  authTestCalls = 0;

  auth = {
    test: async () => {
      this.authTestCalls += 1;
      return { ok: true, team: "T", user: "pmk" };
    },
  };
  chat = {
    postMessage: async (args: unknown) => {
      this.posted.push(args);
      return { ok: true, ts: "1700000000.000001" };
    },
    postEphemeral: async (args: unknown) => {
      this.ephemeral.push(args);
      return { ok: true };
    },
    update: async (args: unknown) => {
      this.updated.push(args);
      return { ok: true };
    },
    delete: async (args: unknown) => {
      this.deleted.push(args);
      return { ok: true };
    },
  };
  reactions = {
    add: async (args: unknown) => {
      this.reactionsAdded.push(args);
      return { ok: true };
    },
    remove: async (args: unknown) => {
      this.reactionsRemoved.push(args);
      return { ok: true };
    },
  };
  views = {
    open: async (args: unknown) => {
      this.viewsOpened.push(args);
      return { ok: true };
    },
  };
  files = {
    upload: async (args: unknown) => {
      this.filesUploaded.push(args);
      return { ok: true };
    },
  };
}

function makeWrapped(): {
  raw: WriteRecorder;
  wrapped: WebClient;
  stats: ReturnType<typeof createDryRunStats>;
  log: { calls: { method: string; payload: unknown }[] };
} {
  const raw = new WriteRecorder();
  const stats = createDryRunStats();
  const log = {
    calls: [] as { method: string; payload: unknown }[],
  };
  const logger = (method: string, payload: unknown) => {
    log.calls.push({ method, payload });
  };
  const wrapped = wrapWebClientForDryRun(raw as unknown as WebClient, {
    stats,
    log: logger,
  });
  return { raw, wrapped, stats, log };
}

describe("dry-run wrapper — write methods (FR3 core)", () => {
  it("stubs chat.postMessage without calling the underlying client", async () => {
    const { raw, wrapped, stats, log } = makeWrapped();
    const res = await wrapped.chat.postMessage({
      channel: "C123",
      text: "hello",
    });
    assert.equal(raw.posted.length, 0);
    assert.equal(stats.postMessage, 1);
    assert.deepEqual(res, { ok: true, dry_run: true });
    assert.equal(log.calls.length, 1);
    assert.equal(log.calls[0].method, "chat.postMessage");
  });

  it("stubs chat.postEphemeral", async () => {
    const { raw, wrapped, stats } = makeWrapped();
    await wrapped.chat.postEphemeral({ channel: "C", user: "U", text: "hi" });
    assert.equal(raw.ephemeral.length, 0);
    assert.equal(stats.postEphemeral, 1);
  });

  it("stubs reactions.add", async () => {
    const { raw, wrapped, stats } = makeWrapped();
    await wrapped.reactions.add({
      channel: "C",
      timestamp: "1700.0",
      name: "white_check_mark",
    });
    assert.equal(raw.reactionsAdded.length, 0);
    assert.equal(stats.reactionAdd, 1);
  });

  it("stubs chat.update + chat.delete (other-writes counter)", async () => {
    const { raw, wrapped, stats } = makeWrapped();
    await wrapped.chat.update({ channel: "C", ts: "1700.0", text: "x" });
    await wrapped.chat.delete({ channel: "C", ts: "1700.0" });
    assert.equal(raw.updated.length, 0);
    assert.equal(raw.deleted.length, 0);
    assert.equal(stats.otherWrites, 2);
  });

  it("stubs reactions.remove + views.open + files.upload (other-writes)", async () => {
    const { raw, wrapped, stats } = makeWrapped();
    await wrapped.reactions.remove({ channel: "C", timestamp: "1700.0", name: "x" });
    await (wrapped.views as { open: (a: unknown) => Promise<unknown> }).open({
      trigger_id: "t",
      view: {},
    });
    await wrapped.files.upload({ channels: "C", content: "hello" });
    assert.equal(raw.reactionsRemoved.length, 0);
    assert.equal(raw.viewsOpened.length, 0);
    assert.equal(raw.filesUploaded.length, 0);
    assert.equal(stats.otherWrites, 3);
  });
});

describe("dry-run wrapper — read methods pass through", () => {
  it("auth.test calls the real client and returns its response", async () => {
    const { raw, wrapped, stats } = makeWrapped();
    const res = await wrapped.auth.test();
    assert.equal(raw.authTestCalls, 1);
    assert.equal(res.ok, true);
    assert.equal(res.team, "T");
    // Reads must not bump any counter.
    assert.equal(stats.postMessage, 0);
    assert.equal(stats.postEphemeral, 0);
    assert.equal(stats.reactionAdd, 0);
    assert.equal(stats.otherWrites, 0);
  });
});

describe("dry-run wrapper — logger", () => {
  it("default logger writes [dry-run] line to stderr", async () => {
    const recorder: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (chunk: string) => boolean }).write =
      (chunk: string): boolean => {
        recorder.push(String(chunk));
        return true;
      };
    try {
      const raw = new WriteRecorder();
      const wrapped = wrapWebClientForDryRun(raw as unknown as WebClient);
      await wrapped.chat.postMessage({
        channel: "C123",
        text: "hello world",
      });
    } finally {
      process.stderr.write = origWrite;
    }
    const joined = recorder.join("");
    assert.match(joined, /\[dry-run\] chat\.postMessage/);
    assert.match(joined, /channel=C123/);
    assert.match(joined, /text="hello world"/);
  });

  it("custom logger receives method name + first arg", async () => {
    const { wrapped, log } = makeWrapped();
    await wrapped.chat.postMessage({ channel: "X", text: "y" });
    assert.equal(log.calls.length, 1);
    assert.equal(log.calls[0].method, "chat.postMessage");
    assert.deepEqual(log.calls[0].payload, { channel: "X", text: "y" });
  });
});

describe("dry-run wrapper — isDryRunActive env probe", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.PMK_DRY_RUN;
    delete process.env.PMK_DRY_RUN;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.PMK_DRY_RUN;
    else process.env.PMK_DRY_RUN = saved;
  });

  it("returns false by default", () => {
    assert.equal(isDryRunActive(), false);
  });

  it("returns true when env=1", () => {
    process.env.PMK_DRY_RUN = "1";
    assert.equal(isDryRunActive(), true);
  });

  it("returns false for any other value", () => {
    process.env.PMK_DRY_RUN = "true"; // intentionally wrong
    assert.equal(isDryRunActive(), false);
  });
});

describe("events partition — dryrun- prefix when env=1", () => {
  let tmpHome: string;
  let savedHome: string | undefined;
  let savedDryRun: string | undefined;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-dryrun-events-"));
    savedHome = process.env.HOME;
    savedDryRun = process.env.PMK_DRY_RUN;
    process.env.HOME = tmpHome;
    delete process.env.PMK_DRY_RUN;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedDryRun === undefined) delete process.env.PMK_DRY_RUN;
    else process.env.PMK_DRY_RUN = savedDryRun;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("gatewayEventsPath uses 'events-' prefix by default", () => {
    const p = gatewayEventsPath();
    assert.match(path.basename(p), /^events-\d{4}-\d{2}\.log$/);
  });

  it("gatewayEventsPath uses 'dryrun-events-' prefix when env=1", () => {
    process.env.PMK_DRY_RUN = "1";
    const p = gatewayEventsPath();
    assert.match(path.basename(p), /^dryrun-events-\d{4}-\d{2}\.log$/);
  });

  it("appendGatewayEvent writes to the dryrun partition under env=1", () => {
    process.env.PMK_DRY_RUN = "1";
    appendGatewayEvent({
      type: "turn.processed",
      actor: "Utest",
      audience: "biz",
      hadMraAsk: false,
      atomsInjected: 0,
    });
    const written = readGatewayEvents({});
    assert.equal(written.length, 1);
    assert.equal(written[0].type, "turn.processed");
    // Files in tmpHome should be under .pmk/gateway/dryrun-events-YYYY-MM.log
    const gwDir = path.join(tmpHome, ".pmk", "gateway");
    const files = fs.readdirSync(gwDir);
    assert.ok(
      files.some((f) => /^dryrun-events-\d{4}-\d{2}\.log$/.test(f)),
      `expected a dryrun-events-*.log; got ${files.join(", ")}`,
    );
    assert.ok(
      !files.some((f) => /^events-\d{4}-\d{2}\.log$/.test(f)),
      `expected NO production events log; got ${files.join(", ")}`,
    );
  });

  it("appendGatewayEvent writes to the prod partition without env", () => {
    appendGatewayEvent({
      type: "turn.processed",
      actor: "Utest",
      audience: "biz",
      hadMraAsk: false,
      atomsInjected: 0,
    });
    const gwDir = path.join(tmpHome, ".pmk", "gateway");
    const files = fs.readdirSync(gwDir);
    assert.ok(files.some((f) => /^events-\d{4}-\d{2}\.log$/.test(f)));
    assert.ok(!files.some((f) => /^dryrun-events/.test(f)));
  });
});
