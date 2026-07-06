import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { GatewayConfig } from "../config";
import { ingestAttachments, summarize } from "../attachments/ingest";
import { fetchSlackFile } from "../attachments/download";
import { loadAttachmentContext } from "../attachments/assemble";
import { appendAttachment } from "../attachments/store";
import {
  MAX_ATTACHMENT_CONTEXT_CHARS,
  type SlackFile,
  type ThreadKey,
  type ExtractedAttachment,
} from "../attachments/types";
import type { ChatMessage } from "@pmk/shared";

export interface AttachmentTurnContext {
  summary: string;
  messages: ChatMessage[];
  entries: ExtractedAttachment[];
}

export type AttachmentIngestFn = (
  files: SlackFile[],
  threadKey: ThreadKey,
) => Promise<AttachmentTurnContext>;
import { resolveGatewayApiKey } from "../config";
import {
  loadUserSession,
  saveUserSession,
} from "../session-store";
import { ChannelMentionHandler } from "./channel-mention";
import { EnvelopeDedup } from "./envelope-dedup";
import { EscalationCoordinator } from "./escalation";
import { FreeChatTurnRunner } from "./free-chat-turn";
import {
  InFlightQueue,
  QueueFullError,
} from "./inflight-queue";
import { PresenceBroadcaster } from "./presence";
import { SlashCommandHandler, slashCommandArgsFromBody } from "./slash-command";
import {
  isDryRunActive,
  wrapWebClientForDryRun,
  type DryRunStats,
  type DryRunStubLogger,
} from "./dry-run-wrapper";
import { wrapWebClientWithTextCap } from "./text-cap-wrapper";
import { SocketHealth, type ConnState } from "../socket-health";
import { createPongTapLogger } from "./socket-logger";
import { SocketWatchdog, makeAdapterWatchdogDeps } from "./socket-watchdog";
import { resolveProvider, type LlmProvider } from "../../llm";
import { loadConfig as loadCliConfig } from "../../config";
import {
  mraDoctor as mraDoctorImpl,
  runMraAsk as runMraAskImpl,
} from "../../adapters/mra";
import { IssueCoordinator, realGithubGateway, type GithubGateway } from "./issue";
import { ReviewCoordinator, realReviewGateway, isReviewRequest, isRetryRequest, isApproveRequest } from "./review";
import { AudioCoordinator, isAudioMessage } from "../audio/coordinator";
import { needsConsentNotice } from "../audio/consent";
import { pickAudience } from "../config";
import {
  approveAtom,
  findAtomByApprovalMessage,
  rejectAtom,
} from "../knowledge";
import { bumpQuestioned } from "../atom-telemetry";
import { readGatewayEvents } from "../events";

// v0.13: re-exported so existing test imports (`gateway.test.ts`) keep
// working after the extractions to `./concurrency` (tranche 1) and
// `./slash-command` (tranche 4).
export { runWithConcurrency } from "./concurrency";
export {
  slashCommandArgsFromBody,
  type SlashCommandScope,
  type SlashCommandArgs,
} from "./slash-command";

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
  /**
   * Injectable GitHub gateway (DI seam for tests). Defaults to the real
   * gh-CLI-backed adapter (`realGithubGateway`).
   */
  github?: GithubGateway;
  /**
   * v0.16 (M3 / FR3): when true (or when `PMK_DRY_RUN=1` is set in the
   * env), the constructed WebClient is wrapped by
   * `wrapWebClientForDryRun` so all Slack writes are stubbed. Read
   * methods still go through to the real client. Pass `dryRunOpts` to
   * inject stats counters / a custom stub logger for tests.
   */
  dryRun?: boolean;
  dryRunOpts?: { stats?: DryRunStats; log?: DryRunStubLogger };
  /**
   * File-attachment ingest seam. Defaults to the real pipeline
   * (ingest → assemble). Tests can substitute a fake to avoid
   * hitting the network or vision API.
   */
  attachmentIngest?: AttachmentIngestFn;
}

/**
 * Pong wait before Socket-Mode treats the connection dead and reconnects (C2).
 * Widened from the @slack/socket-mode 5s default — see the construction site.
 */
const SOCKET_CLIENT_PING_TIMEOUT_MS = 15_000;

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
  /**
   * v0.13: per-user (DM) / per-user-per-channel (mention) FIFO queue
   * for rapid follow-up messages. Pre-v0.13 dropped messages with a
   * `:hourglass: 還在處理` notice that misled users into thinking they
   * were queued; the queue actually does that now and matches the
   * notice semantics.
   */
  private readonly queue: InFlightQueue;
  /** Envelope IDs we've already accepted; protects against Slack retries. */
  private readonly dedup: EnvelopeDedup;
  /** Online/offline broadcast fan-out (#44). */
  private readonly presence: PresenceBroadcaster;
  /** `/pmk <verb>` dispatcher (case CRUD + admin delegation). */
  private readonly slashCommand: SlashCommandHandler;
  /** Outbound escalate + inbound absorb + asker-synthesis follow-up. */
  private readonly escalation: EscalationCoordinator;
  /** 🎫 reaction → GitHub issue coordinator. */
  private readonly issue: IssueCoordinator;
  /** :cr: reaction → mra PR review coordinator. */
  private readonly review: ReviewCoordinator;
  /** Voice message transcription coordinator. */
  private readonly audio: AudioCoordinator;
  /** End-to-end free-chat turn: seed + retrieval + LLM + mra-ask + escalate + reply. */
  private readonly freeChatTurn: FreeChatTurnRunner;
  /** Channel @mention dispatcher (slash / free-chat / case-mode). */
  private readonly channelMention: ChannelMentionHandler;
  /** Socket-Mode health tracker (fed by the pong-tap logger + conn-state events). */
  private readonly health: SocketHealth;
  /** True when a real Slack socket is in use (not the test fake-transport). */
  private readonly realTransport: boolean;
  /** Self-heal watchdog; started in start(), stopped in stop(). */
  private watchdog?: SocketWatchdog;
  /** Set once stop() begins draining. A turn that finishes while this is true
   *  posts a "服務重新啟動" notice to its thread so the user knows the next
   *  follow-up may wait for the restart. */
  private shuttingDown = false;
  /** Epoch ms when this adapter instance was constructed. Used by admin doctor. */
  private readonly startedAt = Date.now();
  /** File-attachment ingest seam — injectable for tests, defaults to real pipeline. */
  private attachmentIngest: AttachmentIngestFn;

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
    this.realTransport = !useFakeTransport;
    this.health = new SocketHealth(Date.now());
    if (opts.socket) {
      this.socket = opts.socket;
    } else {
      this.socket = new SocketModeClient({
        appToken: opts.config.slack.appToken!,
        // C2: widen the pong window from the 5s default to 15s. macOS
        // dark-wakes (MAGICWAKE) + App-Nap timer coalescing briefly delay the
        // pong even with ProcessType=Interactive + caffeinate; a 5s window trips
        // a reconnect on every blip (220 false pong-timeouts/day observed),
        // which is what churns the watchdog. 15s tolerates the blip while still
        // detecting a genuinely dead socket well within the watchdog's backstop.
        clientPingTimeout: SOCKET_CLIENT_PING_TIMEOUT_MS,
        // Tap pong/ping-timeout WARN lines into the health tracker; logs
        // still print as before (level warn).
        logger: createPongTapLogger(() => this.health.recordPongTimeout(Date.now())),
      } as never);
    }
    const rawWeb = opts.web ?? new WebClient(opts.config.slack.botToken!);
    // v0.16 (M3): when `PMK_DRY_RUN=1` (or the explicit dryRun opt is
    // set), wrap the WebClient so every Slack write is stubbed at the
    // outermost layer. Per PRD-2026-0006 Risk 3, individual call sites
    // do NOT branch on dry-run — the proxy is the single source of
    // truth. Read methods (auth.test, users.info, etc.) still pass
    // through to the real client.
    // Defense-in-depth: cap every outgoing chat.* `text` at Slack's hard
    // limit so no call site can leak `msg_too_long` (see text-cap-wrapper).
    // Applied to the real client first; dry-run then wraps the capped one
    // (writes short-circuit under dry-run, so the cap is a no-op there).
    const cappedWeb = wrapWebClientWithTextCap(rawWeb);
    const dryRun = opts.dryRun ?? isDryRunActive();
    this.web = dryRun ? wrapWebClientForDryRun(cappedWeb, opts.dryRunOpts) : cappedWeb;
    if (opts.llm) {
      this.llm = opts.llm;
    } else {
      // v0.12.0: prefer ANTHROPIC_API_KEY from env (already merged by
      // loadCliConfig()), then ~/.pmk/config.json, then gateway.json.
      // The merge happens once at adapter init — running daemons need a
      // restart to pick up a freshly-written gateway.json apiKey, same
      // caveat as audience/escalation config.
      const baseCliConfig = loadCliConfig();
      const { value: apiKey } = resolveGatewayApiKey(
        baseCliConfig.apiKey,
        this.config.apiKey,
      );
      const mergedConfig = { ...baseCliConfig, apiKey };
      this.llm = resolveProvider(mergedConfig);
    }
    this.mraDoctor = opts.mraDoctor ?? mraDoctorImpl;
    this.runMraAsk = opts.runMraAsk ?? runMraAskImpl;
    this.attachmentIngest =
      opts.attachmentIngest ??
      (async (files, threadKey) => {
        const statuses = await ingestAttachments({
          files,
          threadKey,
          botToken: this.config.slack.botToken!,
          llm: this.llm,
          download: fetchSlackFile,
        });
        const { messages, entries } = loadAttachmentContext(
          threadKey,
          MAX_ATTACHMENT_CONTEXT_CHARS,
        );
        return { summary: summarize(statuses), messages, entries };
      });
    this.dedup = new EnvelopeDedup();
    this.presence = new PresenceBroadcaster({
      web: this.web,
      onLog: this.onLog,
      offlineDurationMs: this.offlineDurationMs,
      gracefulShutdown: this.gracefulShutdown,
    });
    this.slashCommand = new SlashCommandHandler({
      web: this.web,
      config: this.config,
      getRuntimeHealthSnapshot: () => ({
        socket: this.health.snapshot(Date.now()),
        watchdog: this.watchdog?.snapshot(),
        startedAt: this.startedAt,
      }),
    });
    this.escalation = new EscalationCoordinator({
      web: this.web,
      config: this.config,
      onLog: this.onLog,
      llm: this.llm,
    });
    this.issue = new IssueCoordinator({
      web: this.web,
      config: this.config,
      onLog: this.onLog,
      github: opts.github ?? realGithubGateway,
    });
    this.review = new ReviewCoordinator({
      web: this.web,
      config: this.config,
      onLog: this.onLog,
      gateway: realReviewGateway,
    });
    this.audio = new AudioCoordinator({
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
    this.channelMention = new ChannelMentionHandler({
      web: this.web,
      llm: this.llm,
      freeChatTurn: this.freeChatTurn,
      slashCommand: this.slashCommand,
      attachmentIngest: this.attachmentIngest,
      audio: this.audio,
      config: this.config,
      botToken: this.config.slack.botToken ?? "",
    });
    this.queue = new InFlightQueue({ onLog: this.onLog });
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
    const CONN_STATES: ConnState[] = [
      "connecting",
      "connected",
      "reconnecting",
      "disconnecting",
      "disconnected",
    ];
    for (const st of CONN_STATES) {
      this.socket.on(st as never, () => this.health.recordConnState(st, Date.now()));
    }
    this.socket.on("connected" as never, () => this.onLog("slack socket connected"));
    this.socket.on("disconnected" as never, () => this.onLog("slack socket disconnected"));

    // Self-heal watchdog: detect a wedged socket → in-process reconnect →
    // loud exit if unrecoverable. Skipped under fake transport (tests).
    // Construct before the connect (so it's ready) but only START its timer
    // AFTER the initial socket.start() succeeds — there's nothing for the
    // watchdog to heal until the socket is up, and starting it earlier could
    // let a first tick race the in-progress initial connect.
    if (this.realTransport) {
      this.watchdog = new SocketWatchdog(
        makeAdapterWatchdogDeps({
          health: this.health,
          socket: this.socket,
          presence: this.presence,
          admins: this.config.admins,
          onLog: this.onLog,
          // C1: the watchdog loud-exit bypasses adapter.stop(), so drain
          // in-flight reviews and audio jobs here too (abort + release) — else
          // a socket-death restart orphans them exactly like the crashes A/C3
          // already fixed.
          beforeExit: () => {
            const n = this.review.drainOnShutdown(this.onLog);
            if (n > 0) this.onLog(`watchdog: drained ${n} in-flight review(s) before loud exit`);
            const na = this.audio.drainOnShutdown(this.onLog);
            if (na > 0) this.onLog(`watchdog: drained ${na} in-flight audio job(s) before loud exit`);
          },
        }),
      );
    }
    await this.socket.start();
    this.watchdog?.start();

    // #44: always invoke presence.backOnline so the audit captures
    // every online transition (suppressed or sent). The presence
    // module itself decides whether to actually broadcast based on
    // offlineDurationMs / gracefulShutdown.
    await this.presence.backOnline();
    return this.botInfo;
  }

  /** v0.13: wait for all pending background work to drain. Used by
   *  the harness in tests so assertions see post-work state. Production
   *  callers can use this on graceful shutdown. */
  async waitForPending(): Promise<void> {
    await this.queue.waitForAll();
  }

  /**
   * Graceful shutdown.
   *
   * Order matters: (1) cut the socket so no new envelopes arrive and
   * the queue stops growing; (2) drain in-flight + queued turns so
   * users actually get their replies (with a bounded timeout so a
   * stuck LLM round can't block SIGTERM forever); (3) broadcast
   * offline last, so presence reflects the true "done" moment.
   *
   * Pre-v0.13 had no queue and stop() finished in <1s; v0.13's
   * fire-and-forget handlers turned shutdown into a real drain
   * problem (PR #55 review: queued turns get abandoned without
   * posting/saving reply if we don't await here).
   */
  async stop(opts: { drainTimeoutMs?: number } = {}): Promise<void> {
    // Flag first: any turn that finishes during the drain below should post the
    // restart notice to its thread (see notifyShutdownRestart + the work closures).
    this.shuttingDown = true;
    this.watchdog?.stop();
    // A (graceful drain): detached `:cr:` reviews and audio jobs run OUTSIDE
    // the turn queue, so `queue.waitForAll()` below never waits for them — a
    // restart would orphan them. Abort + release them here. Synchronous + fast,
    // so it fits the shutdown grace window.
    const drainedReviews = this.review.drainOnShutdown(this.onLog);
    if (drainedReviews > 0) {
      this.onLog(`stop: drained ${drainedReviews} in-flight review(s)`);
    }
    const drainedAudio = this.audio.drainOnShutdown(this.onLog);
    if (drainedAudio > 0) {
      this.onLog(`stop: drained ${drainedAudio} in-flight audio job(s)`);
    }
    try {
      await this.socket.disconnect();
    } catch {
      /* socket may already be closed */
    }

    const timeoutMs = opts.drainTimeoutMs;
    if (timeoutMs !== undefined && timeoutMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      const drained = this.queue.waitForAll().then(() => "drained" as const);
      const winner = await Promise.race([drained, timeout]);
      if (timer) clearTimeout(timer);
      if (winner === "timeout") {
        this.onLog(
          `stop: drain timed out after ${timeoutMs}ms; abandoning remaining in-flight work`,
        );
      }
    } else {
      await this.queue.waitForAll();
    }

    await this.presence.offline();
  }

  /**
   * Best-effort per-turn restart notice. A turn that completes while a graceful
   * shutdown is draining posts this so the user knows their NEXT message may wait
   * for the gateway to come back. Swallows errors — the answer is already posted
   * and the drain must not stall on a flaky notice.
   */
  private async notifyShutdownRestart(
    channel: string,
    threadTs: string,
  ): Promise<void> {
    try {
      await this.web.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: "🔄 服務重新啟動，預計 5–10 分鐘後重新上線",
      });
    } catch {
      /* best-effort: the answer already posted; never block the drain */
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
      await this.web.chat
        .postMessage({
          channel: event.channel!,
          text: "pmk: 你已被 host 加入封鎖名單，無法使用此服務。",
        })
        .catch(() => {});
      return;
    }

    const files = (event.files ?? []) as SlackFile[];
    const text = (event.text ?? "").trim();
    // A file-only DM (no caption) must NOT be dropped — let it through
    // so the attachment pipeline can ingest it. Only skip when both
    // text AND files are absent (truly empty event).
    if (!text && files.length === 0) return;

    // Slack retry of an event we already accepted? Drop silently —
    // we've either replied or are still processing the original.
    if (
      this.dedup.has(payload.envelope_id) ||
      (payload.retry_num ?? 0) > 0
    ) {
      return;
    }
    this.dedup.remember(payload.envelope_id);

    // replyThreadTs: where Slack should anchor the bot's response.
    // sessionThreadTs MUST equal replyThreadTs: the bot threads its reply
    // (anchored at event.ts for a top-level message), so the user's
    // follow-up arrives with thread_ts = that ts. Keying the session by
    // raw event.thread_ts (undefined for the opening message) would store
    // turn 1 under "main" but load turn 2 under the thread → the bot
    // forgets its own first turn. Aligning them means each top-level
    // message opens its own thread-scoped session that its replies
    // continue. (Channel mention path mirrors this below.)
    const replyThreadTs = event.thread_ts ?? event.ts;
    if (!replyThreadTs) return;

    const channel = event.channel!;
    const work = async () => {
      try {
        // If this DM is in a thread that pmk previously escalated AND
        // the sender is one of the IT contacts pmk tagged, absorb the
        // answer into the knowledge store and stop — don't run the
        // normal LLM turn (otherwise we'd answer the IT's reply as if
        // it were a user question).
        const absorbed = await this.escalation.maybeAbsorbReply({
          channelId: channel,
          threadTs: replyThreadTs,
          contributorUserId: userId,
          answerText: text,
        });
        if (absorbed) return;
        await this.handleDmMessage({
          channelId: channel,
          userId,
          text,
          threadTs: replyThreadTs,
          sessionThreadTs: replyThreadTs,
          files,
        });
        // Answer is posted; if we're mid-drain, tell the user the bot is
        // restarting so a follow-up isn't met with silence. Awaited so the
        // notice is part of the drained work (won't be cut by SIGKILL).
        if (this.shuttingDown) {
          await this.notifyShutdownRestart(channel, replyThreadTs);
        }
      } catch (err) {
        this.onLog(
          `error handling DM from ${userId}: ${(err as Error).message}`,
        );
        await this.web.chat
          .postMessage({
            channel,
            thread_ts: event.thread_ts,
            text: `:warning: pmk 內部錯誤：${(err as Error).message}`,
          })
          .catch(() => {});
      }
    };

    let result: "ran" | "queued";
    try {
      result = this.queue.enqueue(userId, work);
    } catch (err) {
      if (err instanceof QueueFullError) {
        await this.web.chat
          .postMessage({
            channel,
            text: ":no_entry: 你已有多則訊息排隊中（上限 3 則），請等回覆後再發。",
          })
          .catch(() => {});
        return;
      }
      throw err;
    }
    if (result === "queued") {
      await this.web.chat
        .postMessage({
          channel,
          text: ":hourglass: 你上一則還在處理，這則已排入隊伍（會依序處理）。",
        })
        .catch(() => {});
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
    // replyThreadTs anchors the bot's response; sessionThreadTs MUST match
    // it (same fix + rationale as the DM path): the bot threads its reply at
    // event.ts for a top-level mention, so the user's in-thread follow-up
    // keys to that ts. Raw event.thread_ts (undefined for the opening
    // mention) would split turn 1 ("channel main") from turn 2 (the thread).
    // Aligning them: each top-level mention opens a thread-scoped free-chat
    // session that its replies continue. The per-conversation turn history
    // (loadChannelTurns/appendChannelTurns → messages.jsonl) is thread-scoped
    // by this key — that's exactly the split being fixed. Case meta
    // (loadChannelMeta: activeCase, lastActiveAt) stays channel-rooted, and
    // the gateway-wide event/audit log is unaffected.
    const replyThreadTs = event.thread_ts ?? event.ts;
    if (!channelId || !userId || !replyThreadTs) return;
    const sessionThreadTs = replyThreadTs;

    // Strip the leading <@BOTID> mention so the model doesn't see it.
    const text = (event.text ?? "")
      .replace(new RegExp(`<@${this.botInfo.botUserId}>`, "g"), "")
      .trim();
    const files = (event.files ?? []) as SlackFile[];
    // A file-only mention (no caption) must NOT be dropped — let it through
    // so the attachment pipeline can ingest it. Only skip when both text AND
    // files are absent (truly empty event).
    if (!text && files.length === 0) return;

    if (this.config.blocklist.includes(userId)) return;

    // Inline `:cr:` + PR link in an @-mention → route to mra PR review
    // (option B-lite) instead of free-chat. DETACHED (same rationale as the DM
    // path): a minutes-long review must not hold this user's turn slot. The
    // coordinator acks now and posts each PR's result when done; .catch is
    // mandatory so a detached rejection can't crash the process.
    // `retry` in a review-result thread → re-run that thread's PR review
    // (re-fetches the thread root `:cr:` message). Detached + .catch like below.
    if (this.review.isEnabled() && isApproveRequest(text)) {
      void this.review
        .fromApproveMessage({ channelId, threadTs: replyThreadTs, userId, text })
        .catch((err) =>
          this.onLog(`review: detached mention approve failed: ${(err as Error).message}`),
        );
      return;
    }
    if (this.review.isEnabled() && isReviewRequest(text)) {
      void this.review
        .fromMessage({ channelId, threadTs: replyThreadTs, userId, text })
        .catch((err) =>
          this.onLog(`review: detached mention review failed: ${(err as Error).message}`),
        );
      return;
    }

    // `retry` command: audio-first so audio threads are never intercepted by
    // review. audio.retryInThread returns false (and posts nothing) for
    // non-audio threads; the caller then falls through to review. Nothing is
    // silently swallowed regardless of which coordinators are enabled.
    if (isRetryRequest(text)) {
      const botToken = this.config.slack.botToken ?? "";
      const tier = pickAudience(this.config, userId, channelId);
      if (await this.audio.retryInThread({ channelId, threadTs: replyThreadTs, userId, botToken, tier })) return;
      // not an audio thread — fall through to review (posts nudge if review is on)
      if (this.review.isEnabled()) {
        await this.review
          .retryInThread({ channelId, threadTs: replyThreadTs, userId })
          .catch((err) =>
            this.onLog(`review: mention retry failed: ${(err as Error).message}`),
          );
      } else {
        // Neither audio nor review owns this thread: inform the user instead
        // of silently dropping the bare retry.
        await this.web.chat
          .postMessage({ channel: channelId, thread_ts: replyThreadTs, text: "這個 thread 沒有可重試的音訊或 PR review。" })
          .catch(() => {});
      }
      return;
    }

    // v0.13: queue key is per-user-per-channel. Different users in the
    // same channel run in parallel; a single user's rapid follow-ups
    // queue up FIFO behind their own in-flight round (up to 3 deep)
    // instead of being silently dropped as in pre-v0.13.
    //
    // Trade-off: when the channel has an active case file
    // (`/pmk open <name>`), parallel @-mentions can still race on
    // `saveCase` (last write wins). In practice case-channels are
    // low-traffic single-thread workflows, so the race is rare;
    // the v0.13 backlog tracks a load-modify-write retry on case
    // files if it bites.
    const queueKey = `${channelId}:${userId}`;
    const work = async () => {
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
        await this.channelMention.run({
          channelId,
          userId,
          text,
          threadTs: replyThreadTs,
          sessionThreadTs,
          files,
        });
        // Answer is posted; if we're mid-drain, tell the user the bot is
        // restarting so a follow-up isn't met with silence. Awaited so the
        // notice is part of the drained work (won't be cut by SIGKILL).
        if (this.shuttingDown) {
          await this.notifyShutdownRestart(channelId, replyThreadTs);
        }
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
      }
    };

    let result: "ran" | "queued";
    try {
      result = this.queue.enqueue(queueKey, work);
    } catch (err) {
      if (err instanceof QueueFullError) {
        await this.web.chat
          .postMessage({
            channel: channelId,
            thread_ts: replyThreadTs,
            text: ":no_entry: 你已有多則訊息排隊中（上限 3 則），請等回覆後再發。",
          })
          .catch(() => {});
        return;
      }
      throw err;
    }
    if (result === "queued") {
      await this.web.chat
        .postMessage({
          channel: channelId,
          thread_ts: replyThreadTs,
          text: ":hourglass: 你上一則還在處理，這則已排入隊伍（會依序處理）。",
        })
        .catch(() => {});
    }
  }

  // ───────────────────────────── DM logic ───────────────────────────────

  private async handleDmMessage(args: {
    channelId: string;
    userId: string;
    text: string;
    threadTs: string;
    sessionThreadTs?: string;
    files?: SlackFile[];
  }): Promise<void> {
    const { channelId, userId, text, threadTs, sessionThreadTs, files } = args;

    if (text.startsWith("/pmk ")) {
      const rest = text.slice(5).trim();
      await this.slashCommand.run({
        channelId,
        threadTs,
        userId,
        rest,
        scope: { kind: "user", userId },
      });
      return;
    }

    // Inline `:cr:` + PR link in a DM → route to mra PR review (option B-lite)
    // instead of free-chat. Gated on review.enabled so a `:cr:` message falls
    // through to normal chat when the feature is off.
    //
    // DETACHED: a review runs for minutes (mra debate). Awaiting it here holds
    // this user's per-user turn slot the whole time, queueing their other DMs
    // ("previous still processing"). Fire-and-forget so the slot frees at once
    // and the user can keep chatting / fire more reviews; the coordinator acks
    // immediately and posts each PR's result when done. MUST .catch — a
    // detached rejection would crash the process (unhandled rejection).
    // `retry` in a review-result thread → re-run that thread's PR review.
    if (this.review.isEnabled() && isApproveRequest(text)) {
      void this.review
        .fromApproveMessage({ channelId, threadTs, userId, text })
        .catch((err) =>
          this.onLog(`review: detached DM approve failed: ${(err as Error).message}`),
        );
      return;
    }
    if (this.review.isEnabled() && isReviewRequest(text)) {
      void this.review
        .fromMessage({ channelId, threadTs, userId, text })
        .catch((err) =>
          this.onLog(`review: detached DM review failed: ${(err as Error).message}`),
        );
      return;
    }

    // `retry` command: audio-first so audio threads are never intercepted by
    // review. audio.retryInThread returns false (and posts nothing) for
    // non-audio threads; the caller then falls through to review. Nothing is
    // silently swallowed regardless of which coordinators are enabled.
    if (isRetryRequest(text)) {
      const botToken = this.config.slack.botToken ?? "";
      const tier = pickAudience(this.config, userId);
      if (await this.audio.retryInThread({ channelId, threadTs, userId, botToken, tier })) return;
      // not an audio thread — fall through to review (posts nudge if review is on)
      if (this.review.isEnabled()) {
        await this.review
          .retryInThread({ channelId, threadTs, userId })
          .catch((err) =>
            this.onLog(`review: DM retry failed: ${(err as Error).message}`),
          );
      } else {
        // Neither audio nor review owns this thread: inform the user instead
        // of silently dropping the bare retry.
        await this.web.chat
          .postMessage({ channel: channelId, thread_ts: threadTs, text: "這個 thread 沒有可重試的音訊或 PR review。" })
          .catch(() => {});
      }
      return;
    }

    // Audio short-circuit: voice messages bypass free-chat and go straight to
    // the transcription pipeline. Detached like review so the DM slot frees at
    // once. The coordinator acks and posts the transcript summary when done.
    if (this.audio.isEnabled() && isAudioMessage(files ?? [])) {
      const botToken = this.config.slack.botToken ?? "";
      const tier = pickAudience(this.config, userId);
      if (needsConsentNotice(`${channelId}:${userId}`)) {
        await this.web.chat
          .postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: "_注意：音訊內容將傳送至 OpenAI 語音轉錄服務處理。_",
          })
          .catch(() => {});
      }
      void this.audio
        .run({
          threadKey: { kind: "dm", userId, threadTs },
          channelId,
          threadTs,
          userId,
          botToken,
          files: files ?? [],
          userText: text || undefined,
          tier,
          scope: "general",
        })
        .catch((err) =>
          this.onLog(`audio: detached DM run failed: ${(err as Error).message}`),
        );
      return;
    }

    // Piece 2: synthetic prompt — when the user sent files but no caption,
    // the turn must not run with an empty text. Override only when text is
    // truly empty; a real caption must NOT be overridden.
    let effectiveText = text;
    if (files && files.length > 0 && !text) {
      effectiveText = "(使用者上傳了檔案但沒有附訊息) 請先讀附件,簡述每份內容並問使用者想用它做什麼。";
    }

    // Attachment wiring: always load persisted context for this thread so
    // prior uploads are visible even when no new files arrive on this
    // turn. When new files ARE present, ingest first (writes to store),
    // then persist any entries the ingest fn returned so fake/test
    // implementations also land entries on disk for subsequent turns.
    const threadKey: ThreadKey = { kind: "dm", userId, threadTs };
    let attachment: AttachmentTurnContext | undefined;
    if (files && files.length > 0) {
      // Piece 3: progress message — post "reading N files…" before ingest,
      // then update the message with the ingest summary (or a fallback)
      // after, so the user sees live feedback during potentially-slow
      // download + extraction.
      const progressRes = await this.web.chat
        .postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `_正在讀取 ${files.length} 個檔案…_`,
        })
        .catch(() => undefined);
      const progressTs = (progressRes as { ts?: string } | undefined)?.ts;

      const ingested = await this.attachmentIngest(files, threadKey);

      if (progressTs) {
        const summary = ingested.summary || "_附件處理完成_";
        await this.web.chat
          .update({
            channel: channelId,
            ts: progressTs,
            text: summary,
          })
          .catch(() => {});
      }

      // Ensure entries are persisted (idempotent) so subsequent turns in
      // the same thread can load them via loadAttachmentContext even when
      // a fake ingest fn didn't write to disk itself.
      for (const entry of ingested.entries) {
        appendAttachment(threadKey, entry);
      }
      attachment = ingested;
    } else {
      // No new files — check for previously stored attachments in this thread.
      const { messages, entries } = loadAttachmentContext(
        threadKey,
        MAX_ATTACHMENT_CONTEXT_CHARS,
      );
      if (entries.length > 0) {
        attachment = { summary: "", messages, entries };
      }
    }

    const session = loadUserSession(userId, sessionThreadTs);
    await this.freeChatTurn.run({
      channelId,
      threadTs,
      text: effectiveText,
      userId,
      session,
      saveSession: (s) => saveUserSession(s, sessionThreadTs),
      attachment,
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

    const reaction = event.reaction;
    const channelId = event.item?.channel;
    const messageTs = event.item?.ts;
    const reactorUserId = event.user;
    if (!channelId || !messageTs || !reactorUserId) return;

    // Blocklist parity with the message / @-mention / slash paths: a blocklisted
    // user must not drive ANY reaction side-effect — :cr: review, :a: GitHub
    // approve, 📚 atom save, or ticket. The typed paths all gate on blocklist;
    // the reaction path previously did not, letting a banned user still trigger
    // the most privileged action (a real PR approve) with a single emoji.
    if (this.config.blocklist.includes(reactorUserId)) return;

    // :cr: → PR review. Unlike approval/ticket reactions, this lands on a
    // USER's message (the PR-request post), so it is handled BEFORE the
    // bot-message guard (which only admits reactions on the bot's own messages).
    if (reaction === "cr") {
      await this.review.fromReaction({ channelId, messageTs, reactorUserId });
      return;
    }
    if (reaction === "a") {
      await this.review.fromApproveReaction({ channelId, messageTs, reactorUserId });
      return;
    }

    // Remaining reactions (approval / ticket / citation-feedback) only apply
    // to the bot's own messages (item_user is the author of the reacted-to message).
    if (event.item_user !== this.botInfo.botUserId) return;

    // 📚 on a bot audio-summary message → save it to the knowledge base.
    if (reaction === "books") {
      if (await this.audio.fromApproval({ channelId, messageTs, reactorUserId })) return;
    }

    const isApprove =
      reaction === "white_check_mark" ||
      reaction === "heavy_check_mark" ||
      reaction === "+1";
    const isReject = reaction === "x" || reaction === "-1";
    // `thumbsdown` is not an approval-reject reaction but is used for
    // citation feedback in the !found branch below.
    const isCitationFeedback = reaction === "thumbsdown";
    const isTicket = reaction === "ticket";
    if (!isApprove && !isReject && !isCitationFeedback && !isTicket) return;

    if (isTicket) {
      await this.issue.fromCandidate({ channelId, anchorTs: messageTs, reactorUserId });
      return;
    }

    const found = findAtomByApprovalMessage(channelId, messageTs);
    if (!found) {
      // Not an approval anchor. If this is a 👎 on a cited bot reply,
      // mark the cited atoms questioned. `x` stays reserved for
      // approval-reject; only -1/thumbsdown means "citation questioned".
      if (reaction === "-1" || reaction === "thumbsdown") {
        // A 👎 reaction always lands on a recent reply, so scanning
        // the last 30 days is safe and avoids a full-partition scan.
        const turn = readGatewayEvents({ sinceMs: Date.now() - 30 * 24 * 60 * 60 * 1000 })
          .filter(
            (e) =>
              e.type === "turn.processed" &&
              e.channelId === channelId &&
              e.replyTs === messageTs &&
              Array.isArray(e.atomIds) &&
              e.atomIds.length > 0,
          )
          .at(-1);
        if (turn && turn.type === "turn.processed" && turn.atomIds) {
          bumpQuestioned(
            turn.atomIds,
            `reaction:${channelId}:${messageTs}:${reactorUserId}:${reaction}`,
          );
        }
      }
      return;
    }

    if (reactorUserId !== found.atom.source.contributorUserId) {
      this.onLog(
        `reaction-approval ignored: ${reactorUserId} is not the atom contributor (${found.atom.source.contributorUserId})`,
      );
      return;
    }

    // thumbsdown is citation-feedback only; it must never act as an
    // approval-reject on a pending-atom anchor.
    if (!isApprove && !isReject) return;

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



  // ─────────────────────────── slash commands ───────────────────────────

  /**
   * v0.9.1 (#39): handle real Slack slash-command envelopes (e.g. user
   * typed `/pmk admin help` in Slack and Slack delivered a
   * `slash_commands` envelope because we registered `/pmk` on the app
   * side). Distinct from the legacy text-message path: `handleDmMessage`
   * (here) and `ChannelMentionHandler.run` (in `./channel-mention.ts`)
   * both forward to `SlashCommandHandler.run` when the user posts a
   * regular message whose trimmed text starts with `/pmk ` (originally
   * a leading-space workaround pre-v0.9.1; still works since `text` is
   * `.trim()`-ed before the prefix check).
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
      await this.slashCommand.run(args);
    } catch (err) {
      this.onLog(
        `error handling slash command from ${args.userId}: ${(err as Error).message}`,
      );
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
    files?: SlackFile[];
  }
  interface AppMentionEvent {
    type: "app_mention";
    user?: string;
    text?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    files?: SlackFile[];
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
