/**
 * v0.13 SlackGateway integration harness.
 *
 * Lets tests drive `SlackAdapter` end-to-end without a real Slack
 * connection or an on-disk CLI config. The three fakes mirror the
 * subset of `@slack/web-api`, `@slack/socket-mode`, and `LlmProvider`
 * that the adapter actually touches; they are cast to the real types
 * at the SlackAdapter construction boundary so the prod code path
 * stays untouched.
 *
 * Each harness gets its own tmp HOME so `~/.pmk/` writes
 * (sessions, atoms, events, admin log) land in disposable scratch
 * space instead of the developer's real home directory.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WebClient } from "@slack/web-api";
import type { SocketModeClient } from "@slack/socket-mode";
import type { ChatMessage } from "@pmk/shared";
import type { LlmProvider } from "../../src/llm/provider";
import type {
  MraAskResult,
  MraDoctorReport,
} from "../../src/adapters/mra";
import { SlackAdapter } from "../../src/gateway/slack";
import {
  GATEWAY_CONFIG_VERSION,
  type GatewayConfig,
} from "../../src/gateway/config";

/** Slack `chat.postMessage` arg shape we care about for assertions. */
export interface PostedMessage {
  channel?: string;
  text?: string;
  thread_ts?: string;
  blocks?: unknown;
  unfurl_links?: boolean;
}

/** Slack `chat.update` arg shape we care about for assertions. */
export interface UpdatedMessage {
  channel?: string;
  ts?: string;
  text?: string;
}

/**
 * Minimal WebClient stand-in. Captures every `chat.postMessage` and
 * `chat.update` so tests can assert on side-effects. All other
 * methods the adapter calls return benign defaults; override via
 * the public fields when a test needs a specific shape.
 */
export class FakeWebClient {
  posted: PostedMessage[] = [];
  updated: UpdatedMessage[] = [];

  authTestResponse: { ok: boolean; user_id?: string; team?: string } = {
    ok: true,
    user_id: "UBOTID",
    team: "test-workspace",
  };
  usersInfoResponse: unknown = {
    ok: true,
    user: { id: "U-ANY", name: "tester", real_name: "Tester" },
  };
  conversationsHistoryResponse: unknown = { ok: true, messages: [] };

  auth = {
    test: async () => this.authTestResponse,
  };

  chat = {
    postMessage: async (args: PostedMessage) => {
      this.posted.push(args);
      return {
        ok: true,
        ts: `1700000000.${String(this.posted.length).padStart(6, "0")}`,
        channel: args.channel,
      };
    },
    update: async (args: UpdatedMessage) => {
      this.updated.push(args);
      return { ok: true };
    },
  };

  users = {
    info: async (_args: { user: string }) => this.usersInfoResponse,
  };

  conversations = {
    history: async (_args: unknown) => this.conversationsHistoryResponse,
  };

  reactions = {
    add: async (_args: unknown) => ({ ok: true }),
    remove: async (_args: unknown) => ({ ok: true }),
  };

  /** Posts targeting a specific channel — handy for asserting DM vs broadcast. */
  postsTo(channel: string): PostedMessage[] {
    return this.posted.filter((p) => p.channel === channel);
  }

  /** Latest posted text, or undefined when nothing posted yet. */
  lastPostText(): string | undefined {
    return this.posted[this.posted.length - 1]?.text;
  }
}

/**
 * Minimal SocketModeClient stand-in. Records `.on(event, handler)`
 * registrations and replays them through `emit(event, payload)` so
 * tests can simulate Slack events deterministically. `start()` and
 * `disconnect()` are no-ops that flip flags for assertion.
 */
export class FakeSocketModeClient {
  started = false;
  stopped = false;
  private handlers = new Map<string, Array<(payload: unknown) => unknown>>();

  on(event: string, handler: (payload: unknown) => unknown): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
  }

  /**
   * Drive an event through every registered handler. Awaits each so
   * tests can synchronously observe side-effects after the call
   * returns.
   */
  async emit(event: string, payload: unknown): Promise<void> {
    const handlers = this.handlers.get(event) ?? [];
    for (const h of handlers) {
      await h(payload);
    }
  }

  handlerCount(event: string): number {
    return this.handlers.get(event)?.length ?? 0;
  }
}

export interface ChatCall {
  systemPrompt: string;
  messages: ChatMessage[];
  actor?: string;
}

/**
 * Scripted LLM. `script(reply, reply, ...)` queues responses in
 * FIFO order; each `chat()` call consumes one. A function entry
 * receives the call (system prompt, messages, actor) and may
 * synthesise the reply dynamically — useful for `mra-ask` directive
 * tests where the second call must reference the first.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly name = "anthropic-api" as const;
  readonly displayName = "fake-llm";

  calls: ChatCall[] = [];
  private scripted: Array<
    string | ((call: ChatCall) => string | Promise<string>)
  > = [];

  script(
    ...replies: Array<string | ((call: ChatCall) => string | Promise<string>)>
  ): this {
    this.scripted.push(...replies);
    return this;
  }

  async chat(
    systemPrompt: string,
    messages: ChatMessage[],
    opts?: { actor?: string },
  ): Promise<string> {
    const call: ChatCall = { systemPrompt, messages, actor: opts?.actor };
    this.calls.push(call);
    if (this.scripted.length === 0) {
      throw new Error(
        `FakeLlmProvider exhausted: no scripted reply for call #${this.calls.length}`,
      );
    }
    const next = this.scripted.shift()!;
    return typeof next === "function" ? await next(call) : next;
  }
}

/**
 * Stand-in for the two `mra` adapter calls SlackAdapter makes
 * (`mraDoctor` + `runMraAsk`). `doctorResponse` defaults to a
 * happy report pointing at a fake workspace path so the doctor
 * pre-check passes; `scriptAsk(...)` queues `runMraAsk` results
 * FIFO. Tests asserting on call args can read `askCalls`.
 */
export interface FakeMraAskCall {
  repo: string;
  question: string;
  cwd: string;
}

export class FakeMra {
  doctorResponse: MraDoctorReport = {
    ok: true,
    binaryPath: "/fake/bin/mra",
    workspace: "/fake/workspace",
  };
  askCalls: FakeMraAskCall[] = [];
  private askScripted: Array<MraAskResult> = [];

  scriptAsk(...results: MraAskResult[]): this {
    this.askScripted.push(...results);
    return this;
  }

  doctor = (
    _opts: { cwd?: string; workspace?: string } = {},
  ): MraDoctorReport => this.doctorResponse;

  runAsk = async (
    args: { repo: string; question: string; cwd: string },
  ): Promise<MraAskResult> => {
    this.askCalls.push({
      repo: args.repo,
      question: args.question,
      cwd: args.cwd,
    });
    if (this.askScripted.length === 0) {
      throw new Error(
        `FakeMra exhausted: no scripted ask result for call #${this.askCalls.length}`,
      );
    }
    return this.askScripted.shift()!;
  };
}

/** Defaults a test can override piecewise via `buildHarness({ config: ... })`. */
function defaultGatewayConfig(): GatewayConfig {
  return {
    version: GATEWAY_CONFIG_VERSION,
    admins: [],
    blocklist: [],
    audience: { default: "tech", users: {}, channels: {} },
    escalation: { default: [], repos: {} },
    slack: {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      botUserId: "UBOTID",
      workspaceName: "test-workspace",
    },
  };
}

export interface Harness {
  adapter: SlackAdapter;
  web: FakeWebClient;
  socket: FakeSocketModeClient;
  llm: FakeLlmProvider;
  mra: FakeMra;
  /** Absolute path to the tmp HOME the harness redirected to. */
  home: string;
  /** Restores `$HOME` and removes the tmp dir. Idempotent. */
  cleanup: () => void;
}

export interface BuildHarnessOptions {
  config?: Partial<GatewayConfig>;
  wasOffline?: boolean;
  lastSeenAt?: number;
  offlineDurationMs?: number;
  gracefulShutdown?: boolean;
  onLog?: (msg: string) => void;
}

/**
 * Build a SlackAdapter wired to fakes, with `$HOME` pointed at a
 * fresh tmp dir so all `~/.pmk/` writes (sessions, atoms,
 * events-YYYY-MM.log, admin.log) stay isolated. Caller MUST invoke
 * `cleanup()` (typically in `afterEach`) to restore `$HOME` and
 * remove the scratch dir.
 */
export function buildHarness(opts: BuildHarnessOptions = {}): Harness {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-slack-harness-"));
  const origHome = process.env.HOME;
  process.env.HOME = home;
  let restored = false;

  const web = new FakeWebClient();
  const socket = new FakeSocketModeClient();
  const llm = new FakeLlmProvider();
  const mra = new FakeMra();

  const config: GatewayConfig = {
    ...defaultGatewayConfig(),
    ...opts.config,
  };

  const adapter = new SlackAdapter({
    config,
    wasOffline: opts.wasOffline ?? false,
    lastSeenAt: opts.lastSeenAt,
    offlineDurationMs: opts.offlineDurationMs,
    gracefulShutdown: opts.gracefulShutdown,
    onLog: opts.onLog,
    web: web as unknown as WebClient,
    socket: socket as unknown as SocketModeClient,
    llm,
    mraDoctor: mra.doctor,
    runMraAsk: mra.runAsk,
  });

  return {
    adapter,
    web,
    socket,
    llm,
    mra,
    home,
    cleanup: () => {
      if (restored) return;
      restored = true;
      if (origHome !== undefined) {
        process.env.HOME = origHome;
      } else {
        delete process.env.HOME;
      }
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

/** Slack `message` event payload builder for DMs (channel starts with "D"). */
export function dmMessagePayload(args: {
  user: string;
  text: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  envelope_id?: string;
  retry_num?: number;
}): {
  ack: () => Promise<void>;
  envelope_id: string;
  retry_num: number;
  event: {
    type: "message";
    user: string;
    text: string;
    channel: string;
    ts: string;
    thread_ts?: string;
  };
} {
  const channel = args.channel ?? "D-USER-DM";
  const ts = args.ts ?? "1700000100.000100";
  return {
    ack: async () => undefined,
    envelope_id: args.envelope_id ?? `env-${ts}-${args.user}`,
    retry_num: args.retry_num ?? 0,
    event: {
      type: "message",
      user: args.user,
      text: args.text,
      channel,
      ts,
      thread_ts: args.thread_ts,
    },
  };
}

/** Slack `slash_commands` envelope payload builder. */
export function slashCommandPayload(args: {
  user_id: string;
  channel_id?: string;
  text: string;
  envelope_id?: string;
}): {
  ack: () => Promise<void>;
  envelope_id: string;
  retry_num: number;
  body: {
    command: string;
    text: string;
    user_id: string;
    channel_id: string;
  };
} {
  const channel_id = args.channel_id ?? "D-HOST-DM";
  return {
    ack: async () => undefined,
    envelope_id: args.envelope_id ?? `env-slash-${args.user_id}-${Date.now()}`,
    retry_num: 0,
    body: {
      command: "/pmk",
      text: args.text,
      user_id: args.user_id,
      channel_id,
    },
  };
}

/** Slack `app_mention` event payload builder for channel @-mentions. */
export function appMentionPayload(args: {
  user: string;
  text: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  envelope_id?: string;
}): {
  ack: () => Promise<void>;
  envelope_id: string;
  retry_num: number;
  event: {
    type: "app_mention";
    user: string;
    text: string;
    channel: string;
    ts: string;
    thread_ts?: string;
  };
} {
  const channel = args.channel ?? "C-CHANNEL";
  const ts = args.ts ?? "1700000200.000200";
  return {
    ack: async () => undefined,
    envelope_id: args.envelope_id ?? `env-${ts}-${args.user}`,
    retry_num: 0,
    event: {
      type: "app_mention",
      user: args.user,
      text: args.text,
      channel,
      ts,
      thread_ts: args.thread_ts,
    },
  };
}
