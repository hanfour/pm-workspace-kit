import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { GatewayConfig } from "../config";
import { pickAudience, pickEscalationPool } from "../config";
import {
  formatBackOnlineNotice,
  formatOfflineNotice,
  formatTrackingSummary,
  markdownToMrkdwn,
  truncateForSlack,
} from "../formatters";
import {
  channelCasesDir,
  clearThreadEscalation,
  listRecentChannels,
  listRecentUsers,
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
import type { ChatMessage } from "@pmk/shared";
import { pickGatewayPrompt } from "@pmk/shared";
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
  listMraWorkspaceReposWithPkb,
  loadPkbBase,
  mraDoctor,
  resolveMraRepo,
  runMraAsk,
} from "../../adapters/mra";
import { parseMraAsk, stripMraAskBlock } from "../mra-ask";
import { parseEscalate, stripEscalateBlock } from "../escalate";
import {
  formatAtomsForInjection,
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

/**
 * Cap for `seenEnvelopes`. Slack retries any un-acked event up to 3
 * times within ~30s; 2 000 entries gives a generous window even on
 * noisy workspaces while keeping memory bounded for long-running hosts.
 */
const SEEN_ENVELOPES_MAX = 2000;

/** Approximate token cost from a list of messages. ~3.5 chars/token,
 * matching the existing per-turn heuristic. */
function approxTokensFor(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += m.content.length;
  return Math.ceil(total / 3.5);
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
  /** Envelope IDs we've already accepted; protects against Slack retries.
   * Bounded LRU — see {@link SEEN_ENVELOPES_MAX}. */
  private seenEnvelopes: string[] = [];
  private seenEnvelopeSet = new Set<string>();

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
      this.seenEnvelopeSet.has(payload.envelope_id) ||
      (payload.retry_num ?? 0) > 0
    ) {
      return;
    }
    this.rememberEnvelope(payload.envelope_id);

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
      this.seenEnvelopeSet.has(payload.envelope_id) ||
      (payload.retry_num ?? 0) > 0
    ) {
      return;
    }
    this.rememberEnvelope(payload.envelope_id);
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

    if (this.inFlight.has(channelId)) {
      await this.web.chat.postMessage({
        channel: channelId,
        thread_ts: replyThreadTs,
        text: ":hourglass: 已有訊息在處理中，請稍候。",
      });
      return;
    }

    this.inFlight.add(channelId);
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
      this.inFlight.delete(channelId);
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
    if (session.messages.length === 0 && this.config.defaultIngest) {
      const seed = buildIngestSeed(
        this.config.defaultIngest,
        this.config.mraWorkspace,
      );
      if (seed) {
        session.messages.push({ role: "user", content: seed });
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
    const llmMessages: ChatMessage[] = [
      ...retrievalPrefix,
      ...session.messages,
      { role: "user", content: text },
    ];

    session.messages.push({ role: "user", content: text });
    session.turns += 1;

    const placeholder = await this.web.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: ":hourglass_flowing_sand: thinking…",
    });

    const audience = pickAudience(this.config, userId);
    const systemPrompt = pickGatewayPrompt(audience);

    let full = "";
    try {
      full = await this.llm.chat(systemPrompt, llmMessages, {
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

    // If the model asked us to delegate a deep code-search round to
    // mra, run it and feed the result back for synthesis.
    const askReq = parseMraAsk(full);
    if (askReq) {
      full = await this.handleMraAskRound({
        channelId,
        placeholderTs: String(placeholder.ts),
        session,
        retrievalPrefix,
        firstResponse: full,
        request: askReq,
        systemPrompt,
      });
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

    await this.web.chat.update({
      channel: channelId,
      ts: String(placeholder.ts),
      text: truncateForSlack(markdownToMrkdwn(visible)),
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
    if (pool.length === 0) {
      this.onLog(
        `escalate requested (repo=${request.repo ?? "—"}) but no contacts configured; skipping mention`,
      );
      return;
    }
    const mentions = pool.map((id) => `<@${id}>`).join(" ");
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
      mentionedUserIds: pool,
      askerUserId,
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
      const file = saveAtom(atom);
      this.onLog(`absorbed knowledge atom → ${file}`);
      await this.web.chat
        .postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `:books: pmk 已吸收這份補充（標籤：${atom.tags.join(", ") || "—"}）。下次有人問類似問題會直接帶進來。`,
        })
        .catch(() => {});
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
    const audience = pickAudience(this.config, askerUserId);
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
    firstResponse: string;
    request: { repo: string; question: string };
    systemPrompt: string;
  }): Promise<string> {
    const {
      channelId,
      placeholderTs,
      session,
      retrievalPrefix,
      firstResponse,
      request,
      systemPrompt,
    } = args;
    const doctor = mraDoctor({ workspace: this.config.mraWorkspace });
    if (!doctor.ok || !doctor.workspace) {
      // Host-side log so the gateway operator can see WHY mra-ask
      // bailed (config-fixable vs binary-missing vs workspace-stale).
      this.onLog(`mra-ask short-circuited: ${doctor.reason ?? "(no reason)"}`);
      // Surface as a synthetic mra failure so the model can degrade gracefully.
      return await this.synthesiseAfterMra({
        session,
        retrievalPrefix,
        firstResponse,
        request,
        systemPrompt,
        result: {
          ok: false,
          stdout: "",
          stderr: "",
          reason:
            doctor.reason ?? "mra workspace unavailable on the host machine",
        },
      });
    }

    await this.web.chat
      .update({
        channel: channelId,
        ts: placeholderTs,
        text: `:mag: 正在用 mra 查 \`${request.repo}\` 的 code…（最多 2 分鐘）`,
      })
      .catch(() => {});

    this.onLog(
      `mra ask repo=${request.repo} q=${truncate(request.question, 120)}`,
    );
    const result = await runMraAsk({
      repo: request.repo,
      question: request.question,
      cwd: doctor.workspace,
    });
    if (!result.ok) {
      this.onLog(`mra ask failed: ${result.reason ?? "(no reason)"}`);
    }

    return await this.synthesiseAfterMra({
      session,
      retrievalPrefix,
      firstResponse,
      request,
      result,
      systemPrompt,
    });
  }

  /**
   * Push the model's first (preamble) response and an `mra-result`
   * user message into the session, then re-call the LLM. The mra
   * result message is later kept in session history so follow-up
   * turns can reference it.
   */
  private async synthesiseAfterMra(args: {
    session: FreeChatSession;
    retrievalPrefix: ChatMessage[];
    firstResponse: string;
    request: { repo: string; question: string };
    result: { ok: boolean; stdout: string; stderr: string; reason?: string };
    systemPrompt: string;
  }): Promise<string> {
    const {
      session,
      retrievalPrefix,
      firstResponse,
      request,
      result,
      systemPrompt,
    } = args;
    session.messages.push({ role: "assistant", content: firstResponse });
    const mraMessage = result.ok
      ? [
          `這是 \`mra ask ${request.repo}\` 的回傳結果（請依此 synthesise 最終答案；若這份結果不足，可再 emit 一次 mra-ask，但仍以 PKB + 這份結果優先）：`,
          "",
          "```mra-result",
          truncate(result.stdout.trim(), 24_000),
          "```",
        ].join("\n")
      : [
          `\`mra ask ${request.repo}\` 失敗：${result.reason ?? "unknown"}`,
          "請以目前已載入的 PKB context 直接回答；若 PKB 也不足，請老實說「目前資料不夠」，不要編造。",
        ].join("\n");
    session.messages.push({ role: "user", content: mraMessage });

    // Retrieval atoms come back here too — synthesis benefits from
    // both the retrieved knowledge AND the fresh mra-result.
    return await this.llm.chat(
      systemPrompt,
      [...retrievalPrefix, ...session.messages],
      { onToken: () => {} },
    );
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

  /** Bounded-LRU insert into the envelope dedup cache. */
  private rememberEnvelope(envelopeId: string): void {
    this.seenEnvelopeSet.add(envelopeId);
    this.seenEnvelopes.push(envelopeId);
    if (this.seenEnvelopes.length > SEEN_ENVELOPES_MAX) {
      const evict = this.seenEnvelopes.shift();
      if (evict !== undefined) this.seenEnvelopeSet.delete(evict);
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

/**
 * Build a one-shot seed message containing PKB content for the
 * configured ingest spec. Returns undefined when no PKB is found.
 *
 * Pattern: same as the case command's buildSeedMessage — we package
 * the four base docs per repo so the model can ground answers in real
 * module names / API endpoints.
 *
 * `mraWorkspace` overrides the cwd-walk in mraDoctor; pass through
 * cfg.mraWorkspace so the seed can be built from any launch directory.
 */
function buildIngestSeed(
  ingestSpec: string,
  mraWorkspace?: string,
): string | undefined {
  const doctor = mraDoctor({ workspace: mraWorkspace });
  if (!doctor.ok) return undefined;
  const tail = ingestSpec.startsWith("mra:") ? ingestSpec.slice(4) : ingestSpec;
  const repos =
    tail === "--all"
      ? listMraWorkspaceReposWithPkb(doctor.workspace!)
      : tail
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean);

  const blocks: string[] = [];
  for (const repo of repos) {
    const repoPath = resolveMraRepo(doctor.workspace!, repo);
    if (!repoPath) continue;
    const docs = loadPkbBase(repoPath);
    if (docs.length === 0) continue;
    blocks.push(
      [
        `## repo: ${repo}`,
        ...docs.map(
          (d) => `### ${d.name}\n\n\`\`\`markdown\n${d.content.trim()}\n\`\`\``,
        ),
      ].join("\n\n"),
    );
  }
  if (blocks.length === 0) return undefined;
  return [
    "我先把 workspace 的 PKB context 給你（後續對話請用這些事實作答；缺的就老實說沒有，不要編造）：",
    "",
    blocks.join("\n\n---\n\n"),
  ].join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…(truncated ${s.length - max} chars)`;
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
