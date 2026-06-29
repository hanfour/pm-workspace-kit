import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AudioCoordinator, isAudioMessage } from "../src/gateway/audio/coordinator";
import { loadAttachments } from "../src/gateway/attachments/store";
import { claimAudio } from "../src/gateway/audio/claim";
import type { ThreadKey, SlackFile } from "../src/gateway/attachments/types";

const ORIG = process.env.HOME;
const KEY: ThreadKey = { kind: "dm", userId: "U1", threadTs: "1.2" };
const af = (over: Partial<SlackFile> = {}): SlackFile => ({
  id: "AF1",
  name: "m.m4a",
  mimetype: "audio/mp4",
  size: 1024,
  url_private_download: "https://files.slack.com/m.m4a",
  ...over,
});

function makeWeb(posted: string[], updated: string[]) {
  return {
    chat: {
      postMessage: async (a: { text?: string }) => {
        posted.push(a.text ?? "");
        return { ts: "p1" };
      },
      update: async (a: { text?: string }) => {
        updated.push(a.text ?? "");
        return {};
      },
    },
  } as never;
}

/** makeWeb variant that also stubs conversations.history for retryInThread tests. */
function makeRetryWeb(
  posted: string[],
  updated: string[],
  rootFiles: SlackFile[],
) {
  return {
    chat: {
      postMessage: async (a: { text?: string }) => {
        posted.push(a.text ?? "");
        return { ts: "p1" };
      },
      update: async (a: { text?: string }) => {
        updated.push(a.text ?? "");
        return {};
      },
    },
    conversations: {
      history: async () => ({ messages: [{ files: rootFiles }] }),
    },
  } as never;
}

const cfg = {
  audio: {
    enabled: true,
    openaiApiKey: { env: "OPENAI_API_KEY" },
    model: "gpt-4o-mini-transcribe",
    language: "zh",
  },
} as never;

const llmStub = {
  name: "anthropic-api" as const,
  displayName: "Test",
  chat: async () => "",
};

function deps(over: Record<string, unknown> = {}) {
  return {
    streamToTemp: async (_f: SlackFile, _t: string, dest: string) => {
      fs.writeFileSync(dest, "AUDIO");
      return { bytes: 5 };
    },
    probe: async () => ({ durationSec: 600, sizeBytes: 1024 }),
    transcribe: async () => ({
      ok: true as const,
      transcript: "逐字稿內容",
      durationSec: 600,
      chunks: 1,
    }),
    summarize: async () => ({ text: "摘要內容", mode: "long" as const, title: "摘要標題", tags: [] as string[] }),
    reserveQuota: () => ({ ok: true as const }),
    makeTempDir: () => fs.mkdtempSync(path.join(os.tmpdir(), "pmk-job-")),
    now: () => 1,
    ...over,
  };
}

describe("AudioCoordinator", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-co-"));
    process.env.HOME = tmp;
    process.env.OPENAI_API_KEY = "sk-x";
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (ORIG) process.env.HOME = ORIG;
    delete process.env.OPENAI_API_KEY;
  });

  it("isAudioMessage detects audio files", () => {
    assert.equal(isAudioMessage([af()]), true);
    assert.equal(isAudioMessage([{ id: "T", mimetype: "text/markdown" }]), false);
  });

  it("transcribes, stores transcript as attachment, posts summary", async () => {
    const posted: string[] = [];
    const updated: string[] = [];
    const co = new AudioCoordinator({
      web: makeWeb(posted, updated),
      config: cfg,
      onLog: () => {},
      llm: llmStub,
      deps: deps() as never,
    });
    await co.run({
      threadKey: KEY,
      channelId: "C",
      threadTs: "1.2",
      userId: "U1",
      botToken: "t",
      files: [af()],
      tier: "pm",
      scope: "general",
    });
    assert.equal(loadAttachments(KEY)[0].text, "逐字稿內容");
    assert.ok([...posted, ...updated].some((m) => m.includes("摘要內容")));
  });

  it("on quota denial: no transcription, posts the reason", async () => {
    const posted: string[] = [];
    const updated: string[] = [];
    let transcribed = false;
    const co = new AudioCoordinator({
      web: makeWeb(posted, updated),
      config: cfg,
      onLog: () => {},
      llm: llmStub,
      deps: deps({
        reserveQuota: () => ({ ok: false, reason: "已達每日上限" }),
        transcribe: async () => {
          transcribed = true;
          return { ok: true, transcript: "x", durationSec: 1, chunks: 1 };
        },
      }) as never,
    });
    await co.run({
      threadKey: KEY,
      channelId: "C",
      threadTs: "1.2",
      userId: "U1",
      botToken: "t",
      files: [af()],
      tier: "pm",
      scope: "general",
    });
    assert.equal(transcribed, false);
    assert.equal(loadAttachments(KEY).length, 0);
    assert.ok([...posted, ...updated].some((m) => m.includes("上限")));
  });

  it("retryInThread: audio thread (channel) → releases claim, runs pipeline with channel key, returns true", async () => {
    const posted: string[] = [];
    const updated: string[] = [];
    const audioFile = af();
    const web = makeRetryWeb(posted, updated, [audioFile]);
    const co = new AudioCoordinator({
      web,
      config: cfg,
      onLog: () => {},
      llm: llmStub,
      deps: deps() as never,
    });
    const result = await co.retryInThread({
      channelId: "C123",
      threadTs: "1.2",
      userId: "U1",
      botToken: "t",
      tier: "pm",
    });
    assert.equal(result, true);
    // run() is detached — drain the microtask queue before checking side effects.
    await new Promise((r) => setImmediate(r));
    // transcript stored under channel key (channelId starts with "C")
    const stored = loadAttachments({ kind: "channel", channelId: "C123", threadTs: "1.2" });
    assert.equal(stored[0]?.text, "逐字稿內容");
  });

  it("retryInThread: audio thread (DM) → uses dm thread key so transcript is retrievable", async () => {
    const posted: string[] = [];
    const updated: string[] = [];
    const audioFile = af();
    const web = makeRetryWeb(posted, updated, [audioFile]);
    const co = new AudioCoordinator({
      web,
      config: cfg,
      onLog: () => {},
      llm: llmStub,
      deps: deps() as never,
    });
    const result = await co.retryInThread({
      channelId: "D123",  // DM channel id starts with "D"
      threadTs: "1.2",
      userId: "U1",
      botToken: "t",
      tier: "pm",
    });
    assert.equal(result, true);
    // run() is detached — drain the microtask queue before checking side effects.
    await new Promise((r) => setImmediate(r));
    // transcript stored under dm key (channelId starts with "D")
    const stored = loadAttachments({ kind: "dm", userId: "U1", threadTs: "1.2" });
    assert.equal(stored[0]?.text, "逐字稿內容");
  });

  it("retryInThread: non-audio thread → returns false, posts nothing", async () => {
    const posted: string[] = [];
    const updated: string[] = [];
    const textFile: SlackFile = {
      id: "TF1",
      name: "notes.txt",
      mimetype: "text/plain",
      size: 100,
    };
    const web = makeRetryWeb(posted, updated, [textFile]);
    const co = new AudioCoordinator({
      web,
      config: cfg,
      onLog: () => {},
      llm: llmStub,
      deps: deps() as never,
    });
    const result = await co.retryInThread({
      channelId: "C",
      threadTs: "1.2",
      userId: "U1",
      botToken: "t",
      tier: "pm",
    });
    assert.equal(result, false);
    // no postMessage, no update — retryInThread posted nothing
    assert.equal(posted.length, 0);
    assert.equal(updated.length, 0);
  });

  it("total transcription failure (no partial): refunds reserved quota", async () => {
    const posted: string[] = [];
    const updated: string[] = [];
    let releaseQuotaCalled = false;
    const co = new AudioCoordinator({
      web: makeWeb(posted, updated),
      config: cfg,
      onLog: () => {},
      llm: llmStub,
      deps: deps({
        transcribe: async () => ({ ok: false as const, reason: "transcribe-failed" as const }),
        releaseQuota: (_args: unknown) => { releaseQuotaCalled = true; },
      }) as never,
    });
    await co.run({
      threadKey: KEY,
      channelId: "C",
      threadTs: "1.2",
      userId: "U1",
      botToken: "t",
      files: [af()],
      tier: "pm",
      scope: "general",
    });
    assert.equal(releaseQuotaCalled, true, "releaseQuota should be called on total failure");
    assert.equal(loadAttachments(KEY).length, 0, "no transcript stored on total failure");
  });

  it("already-claimed file: posts hint and returns without transcribing", async () => {
    const posted: string[] = [];
    const updated: string[] = [];
    // Pre-claim the file so claimAudio returns false inside run()
    claimAudio("AF1");
    let transcribed = false;
    const co = new AudioCoordinator({
      web: makeWeb(posted, updated),
      config: cfg,
      onLog: () => {},
      llm: llmStub,
      deps: deps({
        transcribe: async () => {
          transcribed = true;
          return { ok: true as const, transcript: "x", durationSec: 1, chunks: 1 };
        },
      }) as never,
    });
    await co.run({
      threadKey: KEY,
      channelId: "C",
      threadTs: "1.2",
      userId: "U1",
      botToken: "t",
      files: [af()],
      tier: "pm",
      scope: "general",
    });
    assert.equal(transcribed, false, "transcription should not run for already-claimed file");
    assert.ok(
      [...posted, ...updated].some((m) => m.includes("retry")),
      "should post a hint mentioning retry",
    );
  });

  it("drainOnShutdown aborts an in-flight job and posts the retry notice", async () => {
    const posted: string[] = [];
    let resolveHang!: () => void;
    const hang = new Promise<{
      ok: true;
      transcript: string;
      durationSec: number;
      chunks: number;
    }>((r) => {
      resolveHang = () => r({ ok: true, transcript: "x", durationSec: 1, chunks: 1 });
    });
    const co = new AudioCoordinator({
      web: makeWeb(posted, []),
      config: cfg,
      onLog: () => {},
      llm: llmStub,
      deps: deps({ transcribe: () => hang }) as never,
    });
    const p = co.run({
      threadKey: KEY,
      channelId: "C",
      threadTs: "1.2",
      userId: "U1",
      botToken: "t",
      files: [af()],
      tier: "pm",
      scope: "general",
    });
    await new Promise((r) => setTimeout(r, 10));
    const n = co.drainOnShutdown(() => {});
    assert.equal(n, 1);
    assert.ok(posted.some((m) => m.includes("retry")));
    resolveHang();
    await p;
  });
});
