import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { GatewayConfig } from "../config";
import { isAdmin } from "../config";
import { handleAdminSlash } from "./admin";
import {
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
} from "../session-store";
import {
  appendChannelTurns,
  entriesToMessages,
  loadChannelTurns,
  type ChannelLogEntry,
} from "../channel-log";
import { EnvelopeDedup } from "./envelope-dedup";
import { EscalationCoordinator } from "./escalation";
import {
  FreeChatTurnRunner,
  type FreeChatSession,
} from "./free-chat-turn";
import { PresenceBroadcaster } from "./presence";

// v0.13: re-exported so existing test imports (`gateway.test.ts`) keep
// working after the extraction to `./concurrency`.
export { runWithConcurrency } from "./concurrency";
import { resolveProvider, type LlmProvider } from "../../llm";
import { loadConfig as loadCliConfig } from "../../config";
import { PROMPT_CASE } from "../../prompts";
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
import {
  mraDoctor as mraDoctorImpl,
  runMraAsk as runMraAskImpl,
} from "../../adapters/mra";
import { appendGatewayEvent } from "../events";
import { approxTokensFor } from "../messaging";
import {
  approveAtom,
  findAtomByApprovalMessage,
  rejectAtom,
} from "../knowledge";
import * as path from "node:path";
import * as fs from "node:fs";

// `FreeChatSession` type moved alongside its owner in
// `./free-chat-turn.ts` (v0.13 tranche 3 extraction). It is re-exported
// from there for the channel-log saveSession closure to construct an
// in-memory session that satisfies the runner's generic.

export type SlashCommandScope =
  | { kind: "user"; userId: string }
  | { kind: "channel"; channelId: string };

export interface SlashCommandArgs {
  channelId: string;
  userId: string;
  rest: string;
  scope: SlashCommandScope;
}

/**
 * v0.9.1 (#39): pure translation of a Slack `slash_commands` envelope
 * body into the `handleSlashCommand` arg shape. Exported for tests so
 * the rest/scope decision is verifiable without spinning up a
 * SlackAdapter (which needs real Slack tokens to construct).
 *
 * Returns null when the body lacks the minimum fields the handler
 * needs — caller should drop the envelope.
 */
export function slashCommandArgsFromBody(
  body: { user_id?: string; channel_id?: string; text?: string } | undefined,
): SlashCommandArgs | null {
  if (!body) return null;
  const userId = body.user_id;
  const channelId = body.channel_id;
  if (!userId || !channelId) return null;
  // Empty body text (user typed just `/pmk`) routes to the help surface
  // rather than a "未知指令" reply, so first-time users discover the
  // command list.
  const rest = (body.text ?? "").trim() || "help";
  const scope: SlashCommandScope = channelId.startsWith("D")
    ? { kind: "user", userId }
    : { kind: "channel", channelId };
  return { channelId, userId, rest, scope };
}

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
  /**
   * #44: apparent offline duration in ms — sourced from the
   * graceful-shutdown marker if present, else from `lastSeenAt`.
   * Used to suppress "back online" broadcasts on fast restarts.
   */
  offlineDurationMs?: number;
  /** #44: was the previous exit a graceful shutdown? */
  gracefulShutdown?: boolean;
  /**
   * v0.13 integration-harness hooks (test-only DI). When `web` and
   * `socket` are both provided, the appToken/botToken guard is
   * skipped and these are used in place of the real Slack clients —
   * lets tests drive the full event-handler graph without Slack
   * credentials. When `llm` is provided, the on-disk CLI-config
   * lookup is skipped too. Prod callers pass none of these and get
   * the unchanged real-client construction path.
   */
  web?: WebClient;
  socket?: SocketModeClient;
  llm?: LlmProvider;
  /**
   * v0.13 harness DI: override the `mra ask` round (binary launch) +
   * workspace check. Defaults to the real adapters from
   * `../../adapters/mra`; tests substitute scripted versions so the
   * mra-ask escalate flow can be driven without spawning a real
   * subprocess or needing `mra` on PATH.
   */
  mraDoctor?: typeof mraDoctorImpl;
  runMraAsk?: typeof runMraAskImpl;
}

export class SlackAdapter {
  private socket: SocketModeClient;
  private web: WebClient;
  private config: GatewayConfig;
  private botInfo?: SlackBotInfo;
  private onLog: (msg: string) => void;
  private wasOffline: boolean;
  private lastSeenAt?: number;
  private offlineDurationMs?: number;
  private gracefulShutdown: boolean;
  private llm: LlmProvider;
  private readonly mraDoctor: typeof mraDoctorImpl;
  private readonly runMraAsk: typeof runMraAskImpl;
  private inFlight = new Set<string>();
  /** Envelope IDs we've already accepted; protects against Slack retries. */
  private readonly dedup: EnvelopeDedup;
  /** Online/offline broadcast fan-out (#44). */
  private readonly presence: PresenceBroadcaster;
  /** Outbound escalate + inbound absorb + asker-synthesis follow-up. */
  private readonly escalation: EscalationCoordinator;
  /** End-to-end free-chat turn: seed + retrieval + LLM + mra-ask + escalate + reply. */
  private readonly freeChatTurn: FreeChatTurnRunner;

  constructor(opts: SlackAdapterOptions) {
    // v0.13: token guard only fires on the prod construction path.
    // When both transport fakes are injected, the adapter never opens
    // a real Slack connection so the tokens are irrelevant.
    const useFakeTransport = !!(opts.web && opts.socket);
    if (
      !useFakeTransport &&
      (!opts.config.slack.appToken || !opts.config.slack.botToken)
    ) {
      throw new Error("slack.appToken and slack.botToken must be set");
    }
    this.config = opts.config;
    this.onLog = opts.onLog ?? (() => {});
    this.wasOffline = opts.wasOffline;
    this.lastSeenAt = opts.lastSeenAt;
    this.offlineDurationMs = opts.offlineDurationMs;
    this.gracefulShutdown = opts.gracefulShutdown ?? false;
    if (opts.socket) {
      this.socket = opts.socket;
    } else {
      this.socket = new SocketModeClient({
        appToken: opts.config.slack.appToken!,
        logLevel: "warn" as never, // Avoid noisy stdout in normal operation.
      });
    }
    this.web = opts.web ?? new WebClient(opts.config.slack.botToken!);
    if (opts.llm) {
      this.llm = opts.llm;
    } else {
      // v0.12.0: prefer ANTHROPIC_API_KEY from env (already merged by
      // loadCliConfig()), then ~/.pmk/config.json, then gateway.json.
      // The merge happens once at adapter init — running daemons need a
      // restart to pick up a freshly-written gateway.json apiKey, same
      // caveat as audience/escalation config.
      const baseCliConfig = loadCliConfig();
      const mergedConfig = baseCliConfig.apiKey
        ? baseCliConfig
        : { ...baseCliConfig, apiKey: this.config.apiKey };
      this.llm = resolveProvider(mergedConfig);
    }
    this.mraDoctor = opts.mraDoctor ?? mraDoctorImpl;
    this.runMraAsk = opts.runMraAsk ?? runMraAskImpl;
    this.dedup = new EnvelopeDedup();
    this.presence = new PresenceBroadcaster({
      web: this.web,
      onLog: this.onLog,
      offlineDurationMs: this.offlineDurationMs,
      gracefulShutdown: this.gracefulShutdown,
    });
    this.escalation = new EscalationCoordinator({
      web: this.web,
      config: this.config,
      onLog: this.onLog,
      llm: this.llm,
    });
    this.freeChatTurn = new FreeChatTurnRunner({
      web: this.web,
      config: this.config,
      onLog: this.onLog,
      llm: this.llm,
      mraDoctor: this.mraDoctor,
      runMraAsk: this.runMraAsk,
      escalation: this.escalation,
    });
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
    // v0.8.5 (#21): reaction-based atom approval. Requires
    // `reactions:read` Slack scope + `reaction_added` event subscription
    // on the app side. When the scope isn't granted, no events fire
    // and the handler is silently inert — TTL auto-promote still
    // works as the safety net.
    this.socket.on("reaction_added", (event) =>
      this.handleReactionAdded(event),
    );
    // v0.9.1 (#39): real Slack slash-command path. Requires `/pmk` to
    // be registered as a Slash Command on the Slack app side
    // (https://api.slack.com/apps/<id>/slash-commands). Without that
    // registration Slack's client blocks `/pmk ...` messages with the
    // "/pmk 是無效指令" warning before they reach the bot. With it,
    // `slash_commands` envelopes flow here and skip the leading-space
    // workaround. The legacy ` /pmk ...` text-message path stays in
    // place as a fallback.
    this.socket.on("slash_commands", (event) =>
      this.handleSlashCommandEnvelope(event),
    );
    this.socket.on("disconnected", () =>
      this.onLog("slack socket disconnected"),
    );
    this.socket.on("reconnect", () => this.onLog("slack socket reconnected"));
    await this.socket.start();

    // #44: always invoke presence.backOnline so the audit captures
    // every online transition (suppressed or sent). The presence
    // module itself decides whether to actually broadcast based on
    // offlineDurationMs / gracefulShutdown.
    await this.presence.backOnline();
    return this.botInfo;
  }

  async stop(): Promise<void> {
    await this.presence.offline();
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
      this.dedup.has(payload.envelope_id) ||
      (payload.retry_num ?? 0) > 0
    ) {
      return;
    }
    this.dedup.remember(payload.envelope_id);

    if (this.inFlight.has(userId)) {
      await this.web.chat.postMessage({
        channel: event.channel!,
        text: ":hourglass: 上一則訊息還在處理，請稍候。",
      });
      return;
    }

    this.inFlight.add(userId);
    try {
      // replyThreadTs: where Slack should anchor the bot's response.
      // sessionThreadTs: which conversation history to load — undefined
      // means "main" (top-level DM, no Slack thread); a thread_ts means
      // an in-thread reply, which gets its own isolated session so
      // contexts don't bleed across threads.
      const replyThreadTs = event.thread_ts ?? event.ts;
      if (!replyThreadTs) return;

      // If this DM is in a thread that pmk previously escalated AND the
      // sender is one of the IT contacts pmk tagged, absorb the answer
      // into the knowledge store and stop — don't run the normal LLM
      // turn (otherwise we'd answer the IT's reply as if it were a
      // user question).
      const absorbed = await this.escalation.maybeAbsorbReply({
        channelId: event.channel!,
        threadTs: replyThreadTs,
        contributorUserId: userId,
        answerText: text,
      });
      if (absorbed) return;

      await this.handleDmMessage({
        channelId: event.channel!,
        userId,
        text,
        threadTs: replyThreadTs,
        sessionThreadTs: event.thread_ts,
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
      this.dedup.has(payload.envelope_id) ||
      (payload.retry_num ?? 0) > 0
    ) {
      return;
    }
    this.dedup.remember(payload.envelope_id);
    const channelId = event.channel;
    const userId = event.user;
    // replyThreadTs anchors the bot's response. sessionThreadTs (raw
    // thread_ts, may be undefined) decides which conversation history
    // to load — undefined = channel main; a value = isolated thread.
    const replyThreadTs = event.thread_ts ?? event.ts;
    if (!channelId || !userId || !replyThreadTs) return;
    const sessionThreadTs = event.thread_ts;

    // Strip the leading <@BOTID> mention so the model doesn't see it.
    const text = (event.text ?? "")
      .replace(new RegExp(`<@${this.botInfo.botUserId}>`, "g"), "")
      .trim();
    if (!text) return;

    if (this.config.blocklist.includes(userId)) return;

    // v0.13: lock per-user-per-channel instead of per-channel. The old
    // per-channel key serialised every @-mention in the channel,
    // blocking multi-user Q&A in open channels (different users had
    // to wait for each other's LLM round to finish). Per-user-per-
    // channel still serialises a single user's rapid double-taps (the
    // original intent of the lock) but lets distinct users proceed
    // in parallel.
    //
    // Trade-off: when the channel has an active case file
    // (`/pmk open <name>`), parallel @-mentions can race on
    // `saveCase` (last write wins). In practice case-channels are
    // low-traffic single-thread workflows, so the race is rare;
    // the v0.13 backlog tracks a load-modify-write retry on case
    // files if it bites.
    const inFlightKey = `${channelId}:${userId}`;
    if (this.inFlight.has(inFlightKey)) {
      await this.web.chat.postMessage({
        channel: channelId,
        thread_ts: replyThreadTs,
        text: ":hourglass: 你上一則訊息還在處理，請稍候。",
      });
      return;
    }

    this.inFlight.add(inFlightKey);
    try {
      // Absorb-first: if this thread is pending escalation and the
      // mentioner is one of the tagged IT contacts, treat the message
      // as the expert answer instead of routing to the LLM.
      const absorbed = await this.escalation.maybeAbsorbReply({
        channelId,
        threadTs: replyThreadTs,
        contributorUserId: userId,
        answerText: text,
      });
      if (absorbed) return;

      await this.handleChannelMention({
        channelId,
        userId,
        text,
        threadTs: replyThreadTs,
        sessionThreadTs,
      });
    } catch (err) {
      this.onLog(
        `error handling mention in ${channelId}: ${(err as Error).message}`,
      );
      await this.web.chat
        .postMessage({
          channel: channelId,
          thread_ts: replyThreadTs,
          text: `:warning: pmk 內部錯誤：${(err as Error).message}`,
        })
        .catch(() => {});
    } finally {
      this.inFlight.delete(inFlightKey);
    }
  }

  // ───────────────────────────── DM logic ───────────────────────────────

  private async handleDmMessage(args: {
    channelId: string;
    userId: string;
    text: string;
    threadTs: string;
    sessionThreadTs?: string;
  }): Promise<void> {
    const { channelId, userId, text, threadTs, sessionThreadTs } = args;

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

    const session = loadUserSession(userId, sessionThreadTs);
    await this.freeChatTurn.run({
      channelId,
      threadTs,
      text,
      userId,
      session,
      saveSession: (s) => saveUserSession(s, sessionThreadTs),
    });
  }



  /**
   * v0.8.5 (#21): handle a reaction added to one of pmk's pending-
   * notice messages. ✅ promotes the atom; ❌ deletes it. Layered on
   * top of the v0.7.4 TTL gate — if no reaction comes in, the atom
   * still auto-promotes after 24h.
   *
   * Trust model: the **original IT contributor** (atom.source.
   * contributorUserId) is the only Slack user authorised to react.
   * Random thread participants reacting do nothing. v0.9 admin
   * commands (#31) will add a separate override path.
   */
  private async handleReactionAdded(
    payload: Slack.ReactionEventPayload,
  ): Promise<void> {
    await payload.ack?.().catch(() => {});

    const event = payload?.event;
    if (!event || !this.botInfo) return;
    // We only listen for reactions on the bot's own messages
    // (item_user is the author of the reacted-to message).
    if (event.item_user !== this.botInfo.botUserId) return;
    const reaction = event.reaction;
    const isApprove =
      reaction === "white_check_mark" ||
      reaction === "heavy_check_mark" ||
      reaction === "+1";
    const isReject = reaction === "x" || reaction === "-1";
    if (!isApprove && !isReject) return;

    const channelId = event.item?.channel;
    const messageTs = event.item?.ts;
    const reactorUserId = event.user;
    if (!channelId || !messageTs || !reactorUserId) return;

    const found = findAtomByApprovalMessage(channelId, messageTs);
    if (!found) {
      // Reaction on some other bot message — not an atom-pending one.
      return;
    }

    if (reactorUserId !== found.atom.source.contributorUserId) {
      this.onLog(
        `reaction-approval ignored: ${reactorUserId} is not the atom contributor (${found.atom.source.contributorUserId})`,
      );
      return;
    }

    if (isApprove) {
      const promoted = approveAtom(found.atom.id);
      this.onLog(
        `reaction-approval: ${found.atom.id} approved via :${reaction}: from ${reactorUserId}`,
      );
      const tags = promoted?.tags?.length ? promoted.tags.join(", ") : "—";
      await this.web.chat
        .postMessage({
          channel: channelId,
          thread_ts: messageTs,
          text: `:books: 已生效（標籤：${tags}），下次同類問題會自動帶進來。`,
        })
        .catch(() => {});
    } else {
      const ok = rejectAtom(found.atom.id);
      this.onLog(
        `reaction-approval: ${found.atom.id} rejected via :${reaction}: from ${reactorUserId} (deleted=${ok})`,
      );
      await this.web.chat
        .postMessage({
          channel: channelId,
          thread_ts: messageTs,
          text: `:wastebasket: 已捨棄，atom 檔案已刪除。`,
        })
        .catch(() => {});
    }
  }



  // ────────────────────────── channel logic ──────────────────────────

  private async handleChannelMention(args: {
    channelId: string;
    userId: string;
    text: string;
    threadTs: string;
    sessionThreadTs?: string;
  }): Promise<void> {
    const { channelId, userId, text, threadTs, sessionThreadTs } = args;

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
      // No active case → behave like a DM: free chat with PKB grounding,
      // per-thread session (top-level mentions share one "main" session,
      // each Slack thread gets an isolated session). Users who want
      // bug-tracking semantics explicitly run `/pmk open <name>`.
      //
      // v0.13: switched from `ChannelChatSession` (read-modify-write
      // `chat-session.json`) to append-only `channel-log.ts`. The legacy
      // model raced when parallel @-mentions in the same channel both
      // load → push → save (last write wins). The append-only log uses
      // atomic `fs.appendFileSync` so two writers both land; the
      // saveSession closure here only appends entries new since this
      // turn's load, filtered by `(role, content)` so prune-trimmed
      // history (local to this request's LLM context) is NOT
      // re-appended.
      const loadedEntries = loadChannelTurns(channelId, sessionThreadTs);
      const initialMessages = entriesToMessages(loadedEntries);
      const initialKeys = new Set(
        initialMessages.map((m) => `${m.role} ${m.content}`),
      );
      const session: FreeChatSession = {
        messages: [...initialMessages],
        turns: loadedEntries.filter(
          (e) => e.role === "user" && e.userId !== undefined,
        ).length,
        approxTokens: approxTokensFor(initialMessages),
      };
      await this.freeChatTurn.run({
        channelId,
        threadTs,
        text,
        userId,
        session,
        saveSession: (s) => {
          const newMessages = s.messages.filter(
            (m) => !initialKeys.has(`${m.role} ${m.content}`),
          );
          if (newMessages.length === 0) return;
          const now = new Date().toISOString();
          const entries: ChannelLogEntry[] = newMessages.map((m) => ({
            ts: now,
            role: m.role,
            content: m.content,
            // Only the message whose content matches the turn's prompt
            // is attributed to the calling user; seed and mra-result
            // user-role messages stay unattributed.
            ...(m.role === "user" && m.content === text
              ? { userId }
              : {}),
          }));
          appendChannelTurns(channelId, sessionThreadTs, entries);
        },
      });
      // Touch channel meta so listRecentChannels picks it up for the
      // offline / online broadcast list.
      saveChannelMeta(meta);
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

  /**
   * v0.9.1 (#39): handle real Slack slash-command envelopes (e.g. user
   * typed `/pmk admin help` in Slack and Slack delivered a
   * `slash_commands` envelope because we registered `/pmk` on the app
   * side). Distinct from the legacy text-message path in
   * `handleDmMessage` / `handleChannelMention` which fires when users
   * type ` /pmk admin help` (leading space) as a regular message.
   *
   * Envelope shape (via @slack/socket-mode):
   *   payload.body = {
   *     command: "/pmk",
   *     text: "admin help",        // args, no /pmk prefix
   *     user_id, channel_id, response_url, ...
   *   }
   *
   * Slack expects `payload.ack()` within 3 s; we ack immediately and
   * post the reply via `chat.postMessage` so the user sees a top-level
   * bot message rather than the auto-disappearing slash-command echo.
   */
  private async handleSlashCommandEnvelope(
    payload: Slack.SlashCommandPayload,
  ): Promise<void> {
    await payload.ack?.().catch(() => {});

    const args = slashCommandArgsFromBody(payload?.body);
    if (!args) return;
    if (this.config.blocklist.includes(args.userId)) return;

    if (
      this.dedup.has(payload.envelope_id) ||
      (payload.retry_num ?? 0) > 0
    ) {
      return;
    }
    this.dedup.remember(payload.envelope_id);

    try {
      await this.handleSlashCommand(args);
    } catch (err) {
      this.onLog(
        `error handling slash command from ${args.userId}: ${(err as Error).message}`,
      );
    }
  }

  private async handleSlashCommand(args: {
    channelId: string;
    /**
     * v0.9.1 (#39): optional. Omitted when invoked via the real Slack
     * `slash_commands` envelope, since slash commands have no anchoring
     * message to thread under. Present when invoked via the legacy
     * leading-space `/pmk` text-message path (Phase 11 backwards compat).
     */
    threadTs?: string;
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
        ...(threadTs ? { thread_ts: threadTs } : {}),
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

      // v0.9.0 (#31): admin-restricted, DM-only gateway-config mutations.
      // Bootstrap (the very first admin) requires terminal access via
      // `pmk gateway admin add` — there is no Slack path to grant
      // yourself admin, by design.
      case "admin": {
        if (scope.kind !== "user") {
          await reply(":no_entry_sign: `/pmk admin` 只能在 DM 使用。");
          return;
        }
        if (!isAdmin(this.config, args.userId)) {
          await reply(":lock: 此命令限管理員使用。");
          return;
        }
        const result = await handleAdminSlash({
          actor: args.userId,
          tokens,
        });
        await reply(result.text);
        return;
      }

      default:
        await reply(`未知指令 \`${cmd}\`。試試 \`/pmk help\`。`);
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
  // v0.8.5 (#21) — reactions:read scope on the Slack app side.
  interface ReactionEvent {
    type: "reaction_added";
    user?: string;
    reaction?: string;
    item_user?: string;
    item?: { type: string; channel: string; ts: string };
  }
  interface ReactionEventPayload {
    ack?: (response?: unknown) => Promise<void>;
    envelope_id: string;
    retry_num?: number;
    retry_reason?: string;
    event?: ReactionEvent;
  }
  // v0.9.1 (#39) — real Slack slash-command envelopes. Shape per
  // @slack/socket-mode body.
  interface SlashCommandBody {
    command?: string;
    text?: string;
    user_id?: string;
    channel_id?: string;
    response_url?: string;
    trigger_id?: string;
    team_id?: string;
  }
  interface SlashCommandPayload {
    ack?: (response?: unknown) => Promise<void>;
    envelope_id: string;
    retry_num?: number;
    retry_reason?: string;
    body?: SlashCommandBody;
  }
}
