import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { GatewayConfig } from "../config";
import {
  formatBackOnlineNotice,
  formatOfflineNotice,
  formatTrackingSummary,
  markdownToMrkdwn,
  truncateForSlack,
} from "../formatters";
import {
  channelCasesDir,
  loadChannelMeta,
  loadUserSession,
  saveChannelMeta,
  saveUserSession,
  userCasesDir,
  type UserSession,
} from "../session-store";
import { resolveProvider, type LlmProvider } from "../../llm";
import { loadConfig as loadCliConfig } from "../../config";
import { PROMPT_CASE, PROMPT_DISCUSS } from "../../prompts";
import {
  applyCaseUpdate,
  caseExists,
  loadCase,
  newCase,
  parseCaseUpdate,
  renderCaseMarkdown,
  saveCase,
  stripCaseUpdateBlock,
} from "../../case";
import * as path from "node:path";
import * as fs from "node:fs";

export interface SlackBotInfo {
  botUserId: string;
  workspaceName: string;
}

export interface SlackAdapterOptions {
  config: GatewayConfig;
  /** Called with one-line breadcrumbs the gateway entry can log. */
  onLog?: (msg: string) => void;
  /** Was the host offline (heartbeat stale) at startup? */
  wasOffline: boolean;
  lastSeenAt?: number;
}

export class SlackAdapter {
  private socket: SocketModeClient;
  private web: WebClient;
  private config: GatewayConfig;
  private botInfo?: SlackBotInfo;
  private onLog: (msg: string) => void;
  private wasOffline: boolean;
  private lastSeenAt?: number;
  private llm: LlmProvider;
  private inFlight = new Set<string>();
  /** Envelope IDs we've already accepted; protects against Slack retries. */
  private seenEnvelopes = new Set<string>();

  constructor(opts: SlackAdapterOptions) {
    if (!opts.config.slack.appToken || !opts.config.slack.botToken) {
      throw new Error("slack.appToken and slack.botToken must be set");
    }
    this.config = opts.config;
    this.onLog = opts.onLog ?? (() => {});
    this.wasOffline = opts.wasOffline;
    this.lastSeenAt = opts.lastSeenAt;
    this.socket = new SocketModeClient({
      appToken: opts.config.slack.appToken,
      logLevel: "warn" as never, // Avoid noisy stdout in normal operation.
    });
    this.web = new WebClient(opts.config.slack.botToken);
    this.llm = resolveProvider(loadCliConfig());
  }

  async start(): Promise<SlackBotInfo> {
    const auth = await this.web.auth.test();
    this.botInfo = {
      botUserId: String(auth.user_id),
      workspaceName: String(auth.team ?? "(unknown)"),
    };
    this.onLog(
      `connected to Slack workspace "${this.botInfo.workspaceName}" as <@${this.botInfo.botUserId}>`,
    );

    this.socket.on("message", (event) => this.handleMessage(event));
    this.socket.on("app_mention", (event) => this.handleAppMention(event));
    this.socket.on("disconnected", () =>
      this.onLog("slack socket disconnected"),
    );
    this.socket.on("reconnect", () => this.onLog("slack socket reconnected"));
    await this.socket.start();

    if (this.wasOffline) {
      await this.broadcastBackOnline();
    }
    return this.botInfo;
  }

  async stop(): Promise<void> {
    await this.broadcastOffline();
    try {
      await this.socket.disconnect();
    } catch {
      /* socket may already be closed */
    }
  }

  // ─────────────────────────── event handlers ───────────────────────────

  private async handleMessage(
    payload: Slack.MessageEventPayload,
  ): Promise<void> {
    // ACK FIRST — Slack retries any event we don't ack within ~3s, and
    // LLM round-trips routinely take longer. Without an early ack the
    // user sees the same prompt processed two or three times.
    await payload.ack?.().catch(() => {});

    const event = payload?.event;
    if (!event || event.subtype === "bot_message") return;
    if (event.bot_id) return; // ignore bots, including ourselves
    if (!this.botInfo) return;
    if (event.user === this.botInfo.botUserId) return;

    const isDm = event.channel?.startsWith("D");
    if (!isDm) return; // app_mention covers channel/non-DM cases

    const userId = event.user;
    if (!userId) return;
    if (this.config.blocklist.includes(userId)) {
      await this.web.chat.postMessage({
        channel: event.channel!,
        text: "pmk: 你已被 host 加入封鎖名單，無法使用此服務。",
      });
      return;
    }

    const text = (event.text ?? "").trim();
    if (!text) return;

    // Slack retry of an event we already accepted? Drop silently —
    // we've either replied or are still processing the original.
    if (
      this.seenEnvelopes.has(payload.envelope_id) ||
      (payload.retry_num ?? 0) > 0
    ) {
      return;
    }
    this.seenEnvelopes.add(payload.envelope_id);

    if (this.inFlight.has(userId)) {
      await this.web.chat.postMessage({
        channel: event.channel!,
        text: ":hourglass: 上一則訊息還在處理，請稍候。",
      });
      return;
    }

    this.inFlight.add(userId);
    try {
      const threadTs = event.thread_ts ?? event.ts;
      if (!threadTs) return;
      await this.handleDmMessage({
        channelId: event.channel!,
        userId,
        text,
        threadTs,
      });
    } catch (err) {
      this.onLog(`error handling DM from ${userId}: ${(err as Error).message}`);
      await this.web.chat
        .postMessage({
          channel: event.channel!,
          thread_ts: event.thread_ts,
          text: `:warning: pmk 內部錯誤：${(err as Error).message}`,
        })
        .catch(() => {});
    } finally {
      this.inFlight.delete(userId);
    }
  }

  private async handleAppMention(
    payload: Slack.AppMentionEventPayload,
  ): Promise<void> {
    await payload.ack?.().catch(() => {});

    const event = payload?.event;
    if (!event || !this.botInfo) return;
    if (
      this.seenEnvelopes.has(payload.envelope_id) ||
      (payload.retry_num ?? 0) > 0
    ) {
      return;
    }
    this.seenEnvelopes.add(payload.envelope_id);
    const channelId = event.channel;
    const userId = event.user;
    const threadTs = event.thread_ts ?? event.ts;
    if (!channelId || !userId || !threadTs) return;

    // Strip the leading <@BOTID> mention so the model doesn't see it.
    const text = (event.text ?? "")
      .replace(new RegExp(`<@${this.botInfo.botUserId}>`, "g"), "")
      .trim();
    if (!text) return;

    if (this.config.blocklist.includes(userId)) return;

    if (this.inFlight.has(channelId)) {
      await this.web.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: ":hourglass: 已有訊息在處理中，請稍候。",
      });
      return;
    }

    this.inFlight.add(channelId);
    try {
      await this.handleChannelMention({
        channelId,
        userId,
        text,
        threadTs,
      });
    } catch (err) {
      this.onLog(
        `error handling mention in ${channelId}: ${(err as Error).message}`,
      );
      await this.web.chat
        .postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `:warning: pmk 內部錯誤：${(err as Error).message}`,
        })
        .catch(() => {});
    } finally {
      this.inFlight.delete(channelId);
    }
  }

  // ───────────────────────────── DM logic ───────────────────────────────

  private async handleDmMessage(args: {
    channelId: string;
    userId: string;
    text: string;
    threadTs: string;
  }): Promise<void> {
    const { channelId, userId, text, threadTs } = args;

    if (text.startsWith("/pmk ")) {
      const rest = text.slice(5).trim();
      await this.handleSlashCommand({
        channelId,
        threadTs,
        userId,
        rest,
        scope: { kind: "user", userId },
      });
      return;
    }

    const session = loadUserSession(userId);
    session.messages.push({ role: "user", content: text });
    session.turns += 1;

    const placeholder = await this.web.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: ":hourglass_flowing_sand: thinking…",
    });

    let full = "";
    try {
      full = await this.llm.chat(PROMPT_DISCUSS, session.messages, {
        onToken: () => {},
      });
    } catch (err) {
      await this.web.chat.update({
        channel: channelId,
        ts: String(placeholder.ts),
        text: `:warning: ${(err as Error).message}`,
      });
      return;
    }
    const visible = stripCaseUpdateBlock(full);
    session.messages.push({ role: "assistant", content: visible });
    session.approxTokens += Math.ceil((text.length + visible.length) / 3.5);
    saveUserSession(session);

    await this.web.chat.update({
      channel: channelId,
      ts: String(placeholder.ts),
      text: truncateForSlack(markdownToMrkdwn(visible)),
    });
  }

  // ────────────────────────── channel logic ──────────────────────────

  private async handleChannelMention(args: {
    channelId: string;
    userId: string;
    text: string;
    threadTs: string;
  }): Promise<void> {
    const { channelId, userId, text, threadTs } = args;

    if (text.startsWith("/pmk ")) {
      const rest = text.slice(5).trim();
      await this.handleSlashCommand({
        channelId,
        threadTs,
        userId,
        rest,
        scope: { kind: "channel", channelId },
      });
      return;
    }

    const meta = loadChannelMeta(channelId);
    if (!meta.activeCase) {
      await this.web.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: "尚未有 active case。先 `@pmk /pmk open <case-name>` 起一個。",
      });
      return;
    }

    const dir = channelCasesDir(channelId);
    const c = loadCase(meta.activeCase, dir);
    c.messages.push({ role: "user", content: text });
    saveCase(c, dir);

    const placeholder = await this.web.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: ":hourglass_flowing_sand: thinking…",
    });

    const response = await this.llm.chat(PROMPT_CASE, c.messages, {
      onToken: () => {},
    });
    const visible = stripCaseUpdateBlock(response);
    c.messages.push({ role: "assistant", content: visible });

    const { actions } = parseCaseUpdate(response);
    const summaries = applyCaseUpdate(c, actions);
    saveCase(c, dir);
    saveChannelMeta(meta);

    await this.web.chat.update({
      channel: channelId,
      ts: String(placeholder.ts),
      text: truncateForSlack(markdownToMrkdwn(visible)),
    });

    const summary = formatTrackingSummary(summaries);
    if (summary) {
      await this.web.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: summary,
      });
    }
  }

  // ─────────────────────────── slash commands ───────────────────────────

  private async handleSlashCommand(args: {
    channelId: string;
    threadTs: string;
    userId: string;
    rest: string;
    scope:
      | { kind: "user"; userId: string }
      | { kind: "channel"; channelId: string };
  }): Promise<void> {
    const { channelId, threadTs, rest, scope } = args;
    const [cmd, ...tokens] = rest.split(/\s+/);
    const arg = tokens.join(" ").trim();
    const dir =
      scope.kind === "user"
        ? userCasesDir(scope.userId)
        : channelCasesDir(scope.channelId);

    const reply = (text: string) =>
      this.web.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text,
      });

    switch (cmd) {
      case "help":
        await reply(
          "*pmk slash commands*\n" +
            "• `/pmk open <name>` — 建立 / 開啟 case\n" +
            "• `/pmk show <name>` — 顯示 case 全貌\n" +
            "• `/pmk close <name> [reason]` — 結案\n" +
            "• `/pmk cases` — 列出此 scope 的 cases\n" +
            "• `/pmk help` — 這份說明",
        );
        return;

      case "open": {
        if (!arg) return void (await reply("usage: `/pmk open <name>`"));
        if (caseExists(arg, dir)) {
          if (scope.kind === "channel") {
            const meta = loadChannelMeta(scope.channelId);
            meta.activeCase = arg;
            saveChannelMeta(meta);
          }
          await reply(
            `已切換 active case 為 \`${arg}\`。直接 @pmk 講話即可，pmk 會自動追蹤。`,
          );
          return;
        }
        const c = newCase({
          name: arg,
          title: arg.replace(/-/g, " "),
          ingest: this.config.defaultIngest ? [this.config.defaultIngest] : [],
        });
        saveCase(c, dir);
        if (scope.kind === "channel") {
          const meta = loadChannelMeta(scope.channelId);
          meta.activeCase = arg;
          saveChannelMeta(meta);
        }
        await reply(`新 case \`${arg}\` 建立完成。`);
        return;
      }

      case "show": {
        const target =
          arg ||
          (scope.kind === "channel"
            ? loadChannelMeta(scope.channelId).activeCase
            : undefined);
        if (!target) return void (await reply("usage: `/pmk show <name>`"));
        if (!caseExists(target, dir))
          return void (await reply(`找不到 case \`${target}\`。`));
        const c = loadCase(target, dir);
        await reply("```" + renderCaseMarkdown(c).slice(0, 3500) + "```");
        return;
      }

      case "close": {
        if (!arg)
          return void (await reply("usage: `/pmk close <name> [reason]`"));
        const [name, ...reasonParts] = arg.split(/\s+/);
        if (!caseExists(name, dir))
          return void (await reply(`找不到 case \`${name}\`。`));
        const c = loadCase(name, dir);
        c.status = "closed";
        if (reasonParts.length) c.resolution = reasonParts.join(" ");
        saveCase(c, dir);
        await reply(`case \`${name}\` 已結案。`);
        return;
      }

      case "cases": {
        const files = fs.existsSync(dir)
          ? fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
          : [];
        if (files.length === 0)
          return void (await reply("(此 scope 還沒有 case)"));
        const lines = files.map((f) => `• \`${path.basename(f, ".json")}\``);
        await reply(["*Cases*", ...lines].join("\n"));
        return;
      }

      default:
        await reply(`未知指令 \`${cmd}\`。試試 \`/pmk help\`。`);
    }
  }

  // ─────────────────────────── broadcasts ───────────────────────────

  private async broadcastOffline(): Promise<void> {
    const text = formatOfflineNotice();
    await this.broadcast(text);
  }

  private async broadcastBackOnline(): Promise<void> {
    const awayMs =
      this.lastSeenAt !== undefined ? Date.now() - this.lastSeenAt : undefined;
    const text = formatBackOnlineNotice(awayMs);
    await this.broadcast(text);
  }

  private async broadcast(text: string): Promise<void> {
    // Recently-active DMs
    const { listRecentUsers, listRecentChannels } =
      await import("../session-store");
    const userIds = listRecentUsers(24);
    for (const uid of userIds) {
      try {
        // Open a DM channel to the user (idempotent).
        const im = await this.web.conversations.open({ users: uid });
        const channel = im.channel?.id;
        if (channel) {
          await this.web.chat.postMessage({ channel, text });
        }
      } catch {
        /* user may have left workspace; skip */
      }
    }
    const channels = listRecentChannels(24);
    for (const c of channels) {
      try {
        await this.web.chat.postMessage({ channel: c.channelId, text });
      } catch {
        /* bot may have been kicked; skip */
      }
    }
  }
}

// ─────────────────────────── ambient Slack types ──────────────────────

declare namespace Slack {
  interface MessageEvent {
    type: "message";
    user?: string;
    bot_id?: string;
    text?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    subtype?: string;
  }
  interface AppMentionEvent {
    type: "app_mention";
    user?: string;
    text?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
  }
  interface MessageEventPayload {
    ack?: (response?: unknown) => Promise<void>;
    envelope_id: string;
    retry_num?: number;
    retry_reason?: string;
    event?: MessageEvent;
  }
  interface AppMentionEventPayload {
    ack?: (response?: unknown) => Promise<void>;
    envelope_id: string;
    retry_num?: number;
    retry_reason?: string;
    event?: AppMentionEvent;
  }
}
