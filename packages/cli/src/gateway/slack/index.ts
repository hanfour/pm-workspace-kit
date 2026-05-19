import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { GatewayConfig } from "../config";
import {
  isAdmin,
  pickAudience,
  pickEffectiveEscalationPool,
  pickEscalationPool,
} from "../config";
import { handleAdminSlash } from "./admin";
import { chatWithContextRetry } from "./context-retry";
import {
  formatTrackingSummary,
  markdownToMrkdwn,
  truncateForSlack,
} from "../formatters";
import {
  channelCasesDir,
  clearThreadEscalation,
  loadChannelChatSession,
  loadChannelMeta,
  loadThreadEscalation,
  loadUserSession,
  saveChannelChatSession,
  saveChannelMeta,
  saveThreadEscalation,
  saveUserSession,
  userCasesDir,
} from "../session-store";
import { EnvelopeDedup } from "./envelope-dedup";
import { PresenceBroadcaster } from "./presence";

// v0.13: re-exported so existing test imports (`gateway.test.ts`) keep
// working after the extraction to `./concurrency`.
export { runWithConcurrency } from "./concurrency";
import type { ChatMessage } from "@pmk/shared";
import { pickGatewayPrompt } from "@pmk/shared";
import { resolveProvider, type LlmProvider } from "../../llm";
import { PmkContextTooLongError } from "../../llm/claude-agent";
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
import { createLastLineThrottle } from "../throttle";
import { sanitizeProgressLine } from "./progress";
import { parseMraAsk, stripMraAskBlock } from "../mra-ask";
import {
  approxTokensFor,
  buildIngestSeed,
  buildMraFailureMessage,
  buildMraSuccessMessage,
  capMessageContent,
  MRA_RESULT_CAP,
  pruneSessionIfNeeded,
  SEED_CAP,
  truncate,
} from "../messaging";
import { parseEscalate, stripEscalateBlock } from "../escalate";
import {
  approveAtom,
  findAtomByApprovalMessage,
  formatAtomsForInjection,
  rejectAtom,
  saveAtom,
  searchAtoms,
  type KnowledgeAtom,
} from "../knowledge";

type KnowledgeAtomLike = Pick<KnowledgeAtom, "question" | "answer" | "summary">;
import { extractKnowledgeAtom } from "../extractor";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Structural shape of any session the free-chat helpers can mutate —
 * UserSession (DM) and ChannelChatSession (channel) both satisfy this.
 */
interface FreeChatSession {
  messages: ChatMessage[];
  turns: number;
  approxTokens: number;
}

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
      const absorbed = await this.maybeAbsorbEscalationReply({
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
      const absorbed = await this.maybeAbsorbEscalationReply({
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
    await this.runFreeChatTurn({
      channelId,
      threadTs,
      text,
      userId,
      session,
      saveSession: (s) => saveUserSession(s, sessionThreadTs),
    });
  }

  /**
   * Free-chat turn shared between DM and channel-without-active-case.
   * On first turn, seeds with PKB from `config.defaultIngest`; runs
   * the LLM under PROMPT_GATEWAY_DM; if the model emits an `mra-ask`
   * directive, runs `mra ask` and synthesises a final answer; finally
   * updates the Slack placeholder with the visible response.
   *
   * The session is generic over UserSession / ChannelChatSession —
   * both have the same {messages, turns, approxTokens} shape we
   * touch here.
   */
  private async runFreeChatTurn<S extends FreeChatSession>(args: {
    channelId: string;
    threadTs: string;
    text: string;
    userId: string;
    session: S;
    saveSession: (s: S) => void;
  }): Promise<void> {
    const { channelId, threadTs, text, userId, session, saveSession } = args;

    // First turn: seed the conversation with PKB context from
    // config.defaultIngest (e.g. mra:--all). Without this the model
    // truthfully says it has no idea about the user's codebase even
    // though we configured the ingest spec at gateway init.
    //
    // v0.11.1: cap the seed at SEED_CAP chars so an `mra:--all` against a
    // large multi-repo workspace can't single-handedly exhaust the
    // model's input window. Emits a `message.capped` event when capping
    // fires so operators can see how often the cap is biting.
    if (session.messages.length === 0 && this.config.defaultIngest) {
      const seedRaw = buildIngestSeed(
        this.config.defaultIngest,
        this.config.mraWorkspace,
      );
      if (seedRaw) {
        const cap = capMessageContent(seedRaw, SEED_CAP);
        if (cap.capped) {
          appendGatewayEvent({
            type: "message.capped",
            actor: userId,
            kind: "seed",
            originalChars: cap.originalChars,
            cappedChars: cap.content.length,
          });
        }
        session.messages.push({ role: "user", content: cap.content });
        session.messages.push({
          role: "assistant",
          content: "了解，已載入 workspace PKB context。請繼續。",
        });
      }
    }

    // Knowledge retrieval: pull any prior IT-supplied atoms that look
    // relevant to this question and inject them as ephemeral context
    // (not persisted to session.messages, so old retrieved answers
    // don't keep stacking up turn after turn).
    const retrieved = searchAtoms(text, { limit: 3 });
    const retrievalPrefix: ChatMessage[] = retrieved.length
      ? [
          { role: "user", content: formatAtomsForInjection(retrieved) },
          {
            role: "assistant",
            content: "收到，這些補充當作 ground truth。",
          },
        ]
      : [];

    // v0.11.1: prune BEFORE the LLM call so a bloated session can be
    // trimmed on its way in, not after it has already triggered
    // msg_too_long. Includes retrievalPrefix and the new user turn in
    // the budget check so the prune reflects what we'll actually send.
    const pruneReport = pruneSessionIfNeeded(session, {
      extra: retrievalPrefix,
      newUser: text,
    });
    if (pruneReport.pruned) {
      this.onLog(
        `pruned session: dropped ${pruneReport.droppedPairs} turn-pair(s); now ${pruneReport.tokensAfter} approx tokens`,
      );
    }

    const placeholder = await this.web.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: ":hourglass_flowing_sand: thinking…",
    });

    const audience = pickAudience(this.config, userId, channelId);
    const systemPrompt = pickGatewayPrompt(audience);

    // T11: wrap llm.chat in the context-too-long retry helper. The
    // buildMessages closure includes the new user turn at the tail so
    // the LLM sees it on both attempts; we deliberately do NOT push it
    // onto session.messages until AFTER the retry succeeds, so a failed
    // turn doesn't pollute persisted history (and so forcePruneToMinimum
    // operates on a coherent paired-history shape).
    const retryResult = await chatWithContextRetry({
      llm: this.llm,
      systemPrompt,
      buildMessages: () => [
        ...retrievalPrefix,
        ...session.messages,
        { role: "user", content: text },
      ],
      session,
      actor: userId,
      retrievalAtoms: retrieved.length,
      phase: "first-call",
    });

    if (!retryResult.ok) {
      const errText =
        retryResult.kind === "context"
          ? ":x: 對話太長，請開新 thread 重新提問"
          : `:warning: ${(retryResult.error as Error).message}`;
      await this.web.chat.update({
        channel: channelId,
        ts: String(placeholder.ts),
        text: errText,
      });
      return;
    }

    // Retry succeeded — NOW commit the new user turn to session history.
    session.messages.push({ role: "user", content: text });
    session.turns += 1;

    let full = retryResult.full;
    let scissorsPrefix = retryResult.scissorsPrefix;

    // If the model asked us to delegate a deep code-search round to
    // mra, run it and feed the result back for synthesis.
    const askReq = parseMraAsk(full);
    if (askReq) {
      try {
        const mraResult = await this.handleMraAskRound({
          channelId,
          placeholderTs: String(placeholder.ts),
          session,
          retrievalPrefix,
          retrievalAtoms: retrieved.length,
          firstResponse: full,
          request: askReq,
          systemPrompt,
          actor: userId,
        });
        full = mraResult.full;
        // T12: if the synthesise round ALSO needed force-prune, the
        // post-prune scissors notice more accurately reflects the final
        // session state than the first-call notice. Two notices stacked
        // would just confuse the user, so the latter wins.
        if (mraResult.scissorsPrefix) {
          scissorsPrefix = mraResult.scissorsPrefix;
        }
      } catch (err) {
        if (err instanceof PmkContextTooLongError) {
          await this.web.chat.update({
            channel: channelId,
            ts: String(placeholder.ts),
            text: ":x: 對話太長，請開新 thread 重新提問",
          });
          return;
        }
        throw err;
      }
    }

    // If the model asked to escalate to a human IT/domain expert, fan
    // out the @-mention before showing the placeholder reply, and
    // remember the thread so the next IT reply gets absorbed. The
    // asker is recorded so the post-absorb synthesis can reply to
    // them once IT answers.
    const escReq = parseEscalate(full);
    if (escReq) {
      await this.handleEscalation({
        channelId,
        threadTs,
        askerUserId: userId,
        request: escReq,
      });
    }

    const visible = stripEscalateBlock(
      stripMraAskBlock(stripCaseUpdateBlock(full)),
    );
    session.messages.push({ role: "assistant", content: visible });
    session.approxTokens = approxTokensFor(session.messages);

    saveSession(session);

    appendGatewayEvent({
      type: "turn.processed",
      actor: userId,
      audience,
      hadMraAsk: askReq !== undefined,
      atomsInjected: retrieved.length,
    });

    await this.web.chat.update({
      channel: channelId,
      ts: String(placeholder.ts),
      text: scissorsPrefix + truncateForSlack(markdownToMrkdwn(visible)),
    });
  }

  /**
   * pmk emits an `escalate` directive → @-mention an IT/domain expert
   * in the thread and persist a pending-escalation marker so the next
   * reply from a registered contributor in the same thread is absorbed
   * into the knowledge store.
   *
   * No-op (with a friendly note) when no escalation pool is configured.
   */
  private async handleEscalation(args: {
    channelId: string;
    threadTs: string;
    askerUserId: string;
    request: { repo?: string; question: string; reason?: string };
  }): Promise<void> {
    const { channelId, threadTs, askerUserId, request } = args;
    const pool = pickEscalationPool(this.config, request.repo);
    // v0.8.2 (#30): filter out the asker themselves — @-mentioning the
    // person who just asked the question is useless and creates the
    // weird "<@U_asker> 想麻煩你補充..." artefact when the pool only
    // happens to contain them. Helper lives in config.ts so it's
    // unit-testable in isolation.
    const effectivePool = pickEffectiveEscalationPool(
      this.config,
      request.repo,
      askerUserId,
    );

    if (effectivePool.length === 0) {
      // Two distinct config gaps land here:
      //   - pool is genuinely empty (host hasn't run `pmk gateway escalation add`)
      //   - pool resolves to [askerUserId] only (would tag self)
      // Pre-v0.8.2 we silently logged + skipped, so the host had no
      // way to know from the Slack thread that the v0.7 escalate flow
      // was suppressed for a config reason. Now we post a visible
      // warning naming the fix.
      this.onLog(
        `escalate requested (repo=${request.repo ?? "—"}) but no usable contacts ` +
          `(pool=[${pool.join(",")}], asker=${askerUserId}); ` +
          `posting config-hint instead of @-mention`,
      );
      const scopeLabel = request.repo ? `\`${request.repo}\`` : "default";
      await this.web.chat
        .postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text:
            `:warning: pmk 想 escalate 這題，但目前 ${scopeLabel} 池沒有設定其他 IT/domain 聯絡人。\n` +
            `host 端設定方式：\n` +
            (request.repo
              ? `\`pmk gateway escalation add ${request.repo} <userId>\`（針對此 repo）\n`
              : "") +
            `\`pmk gateway escalation add default <userId>\`（fallback 池）\n` +
            `bot 仍會用既有 PKB 給出 best-effort 答案；之後設定好 pool 再問同樣問題就會自動 @ 對的人。`,
        })
        .catch((err) => {
          this.onLog(
            `failed to post escalation config-hint: ${(err as Error).message}`,
          );
        });
      // Deliberately do NOT save the pending marker — there's nobody
      // to wait for, so an absorb hook would never fire.
      return;
    }

    const mentions = effectivePool.map((id) => `<@${id}>`).join(" ");
    const reasonLine = request.reason ? `\n_原因_：${request.reason}` : "";
    await this.web.chat
      .postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `${mentions} 想麻煩你補充，pmk 沒有足夠 context 回答這題：\n> ${request.question}${reasonLine}\n\n回覆時請記得 \`@pmk\` 一下（例：\`@pmk 答案是…\`），這樣 pmk 才接得到你的回覆並吸收成 knowledge atom，之後同樣問題就能直接答出來。`,
      })
      .catch((err) => {
        this.onLog(
          `failed to post escalation mention: ${(err as Error).message}`,
        );
      });
    saveThreadEscalation({
      channelId,
      threadTs,
      question: request.question,
      scope: request.repo,
      reason: request.reason,
      pendingSince: Date.now(),
      mentionedUserIds: effectivePool,
      askerUserId,
    });
    appendGatewayEvent({
      type: "escalate.triggered",
      channelId,
      threadTs,
      scope: request.repo,
    });
  }

  /**
   * Try to absorb a reply in a pending-escalation thread into the
   * knowledge store. Called from both DM and channel paths.
   *
   * Returns true if the reply triggered an absorb attempt (success or
   * failure both count — caller may want to acknowledge in Slack).
   */
  private async maybeAbsorbEscalationReply(args: {
    channelId: string;
    threadTs: string;
    contributorUserId: string;
    answerText: string;
  }): Promise<boolean> {
    const { channelId, threadTs, contributorUserId, answerText } = args;
    const esc = loadThreadEscalation(channelId, threadTs);
    if (!esc) return false;
    if (!esc.mentionedUserIds.includes(contributorUserId)) {
      // Random teammate replied; don't absorb. We only trust the
      // people pmk explicitly tagged.
      return false;
    }
    // Claim the marker EAGERLY. Without this, two fast IT replies
    // could both pass the gate and trigger duplicate extraction.
    clearThreadEscalation(channelId, threadTs);
    this.onLog(
      `escalation reply received from ${contributorUserId} in ${channelId}/${threadTs}; extracting`,
    );
    let atom: Awaited<ReturnType<typeof extractKnowledgeAtom>>;
    try {
      atom = await extractKnowledgeAtom(this.llm, {
        question: esc.question,
        reason: esc.reason,
        expertAnswer: answerText,
        scope: esc.scope ?? "general",
        threadKey: `${channelId}:${threadTs}`,
        contributorUserId,
      });
    } catch (err) {
      this.onLog(`extractor failed: ${(err as Error).message}`);
      return true;
    }
    if (!atom) {
      this.onLog("extractor returned no atom (parse failure?); skipping save");
      return true;
    }
    try {
      // First save: atom in pending without approval anchor.
      const file = saveAtom(atom);
      this.onLog(`absorbed knowledge atom (pending) → ${file}`);
      appendGatewayEvent({
        type: "escalate.absorbed",
        channelId,
        threadTs,
        atomId: atom.id,
      });
      const idShort = atom.id.split("-").slice(0, 2).join("-");
      const post = await this.web.chat
        .postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text:
            `:hourglass_flowing_sand: pmk 已收下這份補充（標籤：${atom.tags.join(", ") || "—"}），暫存為 *pending*，` +
            `24 小時後自動生效，期間不會被其他查詢抓到。\n` +
            `直接 ✅ 或 ❌ react 這條訊息可立即 approve / reject；` +
            `或 host 端：\`pmk gateway atoms approve ${idShort}\` / \`pmk gateway atoms reject ${idShort}\``,
        })
        .catch((err) => {
          this.onLog(
            `failed to post pending notice: ${(err as Error).message}`,
          );
          return undefined;
        });
      // v0.8.5 (#21): if the bot's confirmation message landed, anchor
      // the atom to its `ts` so reaction-approval can find it. Re-save
      // — cheap (one extra fs.write) and keeps the storage layer the
      // single-source-of-truth.
      if (post?.ts) {
        const updated: typeof atom = {
          ...atom,
          approval: { channelId, messageTs: String(post.ts) },
        };
        saveAtom(updated);
      }
    } catch (err) {
      this.onLog(`failed to save atom: ${(err as Error).message}`);
      return true;
    }
    // Synthesised follow-up: tag the original asker with the answer
    // so they don't have to re-ask. Best-effort — failures here are
    // logged but don't fail the absorb.
    await this.postSynthesisedAnswerForAsker({
      channelId,
      threadTs,
      askerUserId: esc.askerUserId,
      atom,
    }).catch((err) =>
      this.onLog(`post-absorb synthesis failed: ${(err as Error).message}`),
    );
    return true;
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

  /**
   * After a fresh atom lands, ping the original asker (if known) with
   * a one-shot synthesised answer in audience-appropriate tone, so
   * they don't need to ask the same question a second time.
   */
  private async postSynthesisedAnswerForAsker(args: {
    channelId: string;
    threadTs: string;
    askerUserId?: string;
    atom: KnowledgeAtomLike;
  }): Promise<void> {
    const { channelId, threadTs, askerUserId, atom } = args;
    if (!askerUserId) return;
    const audience = pickAudience(this.config, askerUserId, channelId);
    const systemPrompt = pickGatewayPrompt(audience);
    const synthMessage =
      `IT 同事剛在這條 thread 補上了答案，請依以下事實 synthesise 一段回覆給原本提問的同事 <@${askerUserId}>。語氣依你的 audience prompt。\n\n` +
      `原始問題：${atom.question}\n\n` +
      `IT 答案（verbatim）：\n${atom.answer}\n\n` +
      `Summary：${atom.summary ?? "(none)"}\n\n` +
      `不要再 emit 任何 mra-ask 或 escalate block；這只是把答案傳給原問者。`;
    let reply: string;
    try {
      reply = await this.llm.chat(
        systemPrompt,
        [{ role: "user", content: synthMessage }],
        { onToken: () => {} },
      );
    } catch (err) {
      this.onLog(`synth llm call failed: ${(err as Error).message}`);
      return;
    }
    const visible = stripEscalateBlock(
      stripMraAskBlock(stripCaseUpdateBlock(reply)),
    );
    await this.web.chat
      .postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `<@${askerUserId}> ${truncateForSlack(markdownToMrkdwn(visible))}`,
      })
      .catch((err) =>
        this.onLog(
          `failed to post synthesised follow-up: ${(err as Error).message}`,
        ),
      );
  }

  /**
   * Run one round of `mra ask` on behalf of the model, then re-call
   * the LLM with the result so it can produce a synthesised final
   * answer. Returns the synthesised response (with any directive
   * blocks left intact — caller strips them).
   *
   * Failure modes (mra missing, timeout, non-zero exit) flow back to
   * the LLM as an explicit "mra-result-failed" message so the model
   * can apologise rather than the user seeing a crash.
   */
  private async handleMraAskRound(args: {
    channelId: string;
    placeholderTs: string;
    session: FreeChatSession;
    /** Retrieval atoms injected into the first LLM call; passed
     * through so the synthesis round still sees them. */
    retrievalPrefix: ChatMessage[];
    /** Atom count corresponding to retrievalPrefix; threaded through
     * to synthesiseAfterMra → chatWithContextRetry so the
     * `context.exceeded` audit event records it accurately. */
    retrievalAtoms: number;
    firstResponse: string;
    request: { repo: string; question: string };
    systemPrompt: string;
    /** Slack user ID that triggered this round — recorded in the
     * audit event so per-user mra-ask cost is attributable. */
    actor: string;
  }): Promise<{ full: string; scissorsPrefix: string }> {
    const {
      channelId,
      placeholderTs,
      session,
      retrievalPrefix,
      retrievalAtoms,
      firstResponse,
      request,
      systemPrompt,
      actor,
    } = args;
    const doctor = this.mraDoctor({ workspace: this.config.mraWorkspace });
    if (!doctor.ok || !doctor.workspace) {
      // Host-side log so the gateway operator can see WHY mra-ask
      // bailed (config-fixable vs binary-missing vs workspace-stale).
      this.onLog(`mra-ask short-circuited: ${doctor.reason ?? "(no reason)"}`);
      // Surface as a synthetic mra failure so the model can degrade gracefully.
      return await this.synthesiseAfterMra({
        session,
        retrievalPrefix,
        retrievalAtoms,
        firstResponse,
        request,
        systemPrompt,
        actor,
        result: {
          ok: false,
          stdout: "",
          stderr: "",
          reason:
            doctor.reason ?? "mra workspace unavailable on the host machine",
        },
      });
    }

    const baseProgress = `:mag: 正在用 mra 查 \`${request.repo}\` 的 code…（最多 5 分鐘）`;
    await this.web.chat
      .update({
        channel: channelId,
        ts: placeholderTs,
        text: baseProgress,
      })
      .catch(() => {});

    // v0.10 (#22): drip-feed mra's stdout into the placeholder so the
    // user sees movement during the 30–90s round. 3s coalescing
    // window keeps us well under Slack's chat.update rate limit
    // (Tier 3, ~50 rpm) even when mra is chatty.
    const progressThrottle = createLastLineThrottle({
      windowMs: 3000,
      onFire: (line) => {
        // ANSI strip + mrkdwn-meta strip + length cap. See
        // sanitizeProgressLine for rationale.
        const safe = sanitizeProgressLine(line);
        void this.web.chat
          .update({
            channel: channelId,
            ts: placeholderTs,
            text: `${baseProgress}\n> ${safe}`,
          })
          .catch(() => {
            /* progress updates are best-effort; the final synthesis
               update will overwrite anyway */
          });
      },
    });

    this.onLog(
      `mra ask repo=${request.repo} q=${truncate(request.question, 120)}`,
    );
    const mraStartMs = Date.now();
    const result = await this.runMraAsk(
      {
        repo: request.repo,
        question: request.question,
        cwd: doctor.workspace,
      },
      {
        onRetry: (attempt) => {
          this.onLog(
            `mra ask attempt ${attempt} failed without stderr; retrying once`,
          );
        },
        onProgress: (line) => progressThrottle.push(line),
      },
    );
    progressThrottle.cancel();
    appendGatewayEvent({
      type: "mra-ask.end",
      actor,
      repo: request.repo,
      ok: result.ok,
      retried: result.attempts > 1,
      durationMs: Date.now() - mraStartMs,
    });
    if (result.ok && result.attempts > 1) {
      this.onLog(`mra ask succeeded on attempt ${result.attempts}`);
    }
    if (!result.ok) {
      // Diagnostic-friendly: surface stderr / partial stdout so the
      // host operator can see WHY mra exited non-zero. Without this,
      // failures collapse to Node's default "Command failed: <argv>"
      // which is useless when triaging mra integration issues.
      this.onLog(`mra ask failed: ${result.reason ?? "(no reason)"}`);
      if (result.stderr.trim()) {
        this.onLog(`mra ask stderr: ${truncate(result.stderr.trim(), 600)}`);
      }
      if (result.stdout.trim()) {
        this.onLog(
          `mra ask partial stdout: ${truncate(result.stdout.trim(), 200)}`,
        );
      }
    }

    return await this.synthesiseAfterMra({
      session,
      retrievalPrefix,
      retrievalAtoms,
      firstResponse,
      request,
      result,
      systemPrompt,
      actor,
    });
  }

  /**
   * Push the model's first (preamble) response and an `mra-result`
   * user message into the session, then re-call the LLM. The mra
   * result message is later kept in session history so follow-up
   * turns can reference it.
   *
   * T12: wrapped in `chatWithContextRetry` (phase="synthesise") so a
   * post-mra-ask blow-up triggers the same force-prune-and-scissors
   * recovery path as the first-call site. Throws `PmkContextTooLongError`
   * when even the post-prune retry can't fit, letting the caller decide
   * how to surface the failure to Slack (see runFreeChatTurn).
   */
  private async synthesiseAfterMra(args: {
    session: FreeChatSession;
    retrievalPrefix: ChatMessage[];
    retrievalAtoms: number;
    firstResponse: string;
    request: { repo: string; question: string };
    result: { ok: boolean; stdout: string; stderr: string; reason?: string };
    systemPrompt: string;
    actor: string;
  }): Promise<{ full: string; scissorsPrefix: string }> {
    const {
      session,
      retrievalPrefix,
      retrievalAtoms,
      firstResponse,
      request,
      result,
      systemPrompt,
      actor,
    } = args;
    session.messages.push({ role: "assistant", content: firstResponse });

    let mraMessage: string;
    if (result.ok) {
      const cap = capMessageContent(result.stdout, MRA_RESULT_CAP);
      if (cap.capped) {
        appendGatewayEvent({
          type: "message.capped",
          actor,
          kind: "mra-result",
          originalChars: cap.originalChars,
          cappedChars: cap.content.length,
        });
      }
      mraMessage = buildMraSuccessMessage(request.repo, cap.content);
    } else {
      mraMessage = buildMraFailureMessage(request.repo, result);
    }
    session.messages.push({ role: "user", content: mraMessage });

    // Retrieval atoms come back here too — synthesis benefits from
    // both the retrieved knowledge AND the fresh mra-result.
    const retryResult = await chatWithContextRetry({
      llm: this.llm,
      systemPrompt,
      buildMessages: () => [...retrievalPrefix, ...session.messages],
      session,
      actor,
      retrievalAtoms,
      phase: "synthesise",
      chatOptions: { onToken: () => {} },
    });

    if (!retryResult.ok) {
      // Bubble up so the caller (runFreeChatTurn) can post the friendly
      // ":x: 對話太長…" message. Other (non-context) errors are
      // re-thrown as-is and caught by the outer Slack handler.
      if (retryResult.kind === "context") {
        throw new PmkContextTooLongError(retryResult.secondError);
      }
      throw retryResult.error;
    }

    return { full: retryResult.full, scissorsPrefix: retryResult.scissorsPrefix };
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
      const session = loadChannelChatSession(channelId, sessionThreadTs);
      await this.runFreeChatTurn({
        channelId,
        threadTs,
        text,
        userId,
        session,
        saveSession: (s) => saveChannelChatSession(s, sessionThreadTs),
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
