import { WebClient } from "@slack/web-api";
import type { LlmProvider } from "../../llm";
import {
  formatTrackingSummary,
  markdownToMrkdwn,
  truncateForSlack,
} from "../formatters";
import {
  channelCasesDir,
  loadChannelMeta,
  saveChannelMeta,
} from "../session-store";
import {
  appendChannelTurns,
  entriesToMessages,
  loadChannelTurns,
  type ChannelLogEntry,
} from "../channel-log";
import { PROMPT_CASE } from "../../prompts";
import {
  applyCaseUpdate,
  loadCase,
  parseCaseUpdate,
  saveCase,
  stripCaseUpdateBlock,
} from "../../case";
import { approxTokensFor } from "../messaging";
import {
  chatWithContextRetry,
  type ContextRetrySession,
} from "./context-retry";
import type { ChatMessage } from "@pmk/shared";
import {
  FreeChatTurnRunner,
  type FreeChatSession,
} from "./free-chat-turn";
import { SlashCommandHandler } from "./slash-command";
import { appendAttachment } from "../attachments/store";
import { loadAttachmentContext } from "../attachments/assemble";
import {
  MAX_ATTACHMENT_CONTEXT_CHARS,
  type SlackFile,
} from "../attachments/types";
import type { AttachmentIngestFn, AttachmentTurnContext } from "./index";
import type { GatewayConfig } from "../config";
import { pickAudience } from "../config";
import { AudioCoordinator, isAudioMessage } from "../audio/coordinator";
import { needsConsentNotice } from "../audio/consent";

/**
 * v0.13 tranche 4: channel `app_mention` handler extracted from
 * `slack/index.ts`. Owns the "is this a slash, a free-chat turn, or a
 * case-tracking turn?" routing and the case-mode LLM round. Free-chat
 * mode delegates to FreeChatTurnRunner; the `/pmk` prefix delegates to
 * SlashCommandHandler (passed in via constructor so DI stays explicit).
 */

export interface ChannelMentionHandlerOptions {
  web: WebClient;
  llm: LlmProvider;
  freeChatTurn: FreeChatTurnRunner;
  slashCommand: SlashCommandHandler;
  attachmentIngest: AttachmentIngestFn;
  /** Audio coordinator — when present, voice messages short-circuit to transcription. */
  audio?: AudioCoordinator;
  /** Gateway config — used to resolve audience tier for audio. */
  config?: GatewayConfig;
  /** Bot token forwarded to AudioCoordinator.run() for file downloads. */
  botToken?: string;
}

export class ChannelMentionHandler {
  private readonly web: WebClient;
  private readonly llm: LlmProvider;
  private readonly freeChatTurn: FreeChatTurnRunner;
  private readonly slashCommand: SlashCommandHandler;
  private readonly attachmentIngest: AttachmentIngestFn;
  private readonly audio?: AudioCoordinator;
  private readonly config?: GatewayConfig;
  private readonly botToken: string;

  constructor(opts: ChannelMentionHandlerOptions) {
    this.web = opts.web;
    this.llm = opts.llm;
    this.freeChatTurn = opts.freeChatTurn;
    this.slashCommand = opts.slashCommand;
    this.attachmentIngest = opts.attachmentIngest;
    this.audio = opts.audio;
    this.config = opts.config;
    this.botToken = opts.botToken ?? "";
  }

  async run(args: {
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

      // Audio short-circuit: voice messages bypass attachment ingest and go
      // straight to the transcription pipeline. Detached so the user's turn
      // slot frees immediately (same rationale as review). The coordinator
      // acks and posts the summary when done.
      if (this.audio?.isEnabled() && isAudioMessage(files ?? [])) {
        const tier = this.config
          ? pickAudience(this.config, userId, channelId)
          : "tech";
        if (needsConsentNotice(channelId)) {
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
            threadKey: {
              kind: "channel",
              channelId,
              threadTs: sessionThreadTs ?? threadTs,
            },
            channelId,
            threadTs,
            userId,
            botToken: this.botToken,
            files: files ?? [],
            userText: text || undefined,
            tier,
          })
          .catch(() => {});
        return;
      }

      // Attachment wiring (free-chat branch only): ingest new files when
      // present, then load any previously stored context for this thread.
      const threadKey: { kind: "channel"; channelId: string; threadTs: string } = {
        kind: "channel",
        channelId,
        threadTs: sessionThreadTs ?? threadTs,
      };
      let attachment: AttachmentTurnContext | undefined;
      let effectiveText = text;

      if (files && files.length > 0) {
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

        // Ensure entries are persisted so subsequent turns can load them.
        for (const entry of ingested.entries) {
          appendAttachment(threadKey, entry);
        }
        attachment = ingested;

        // Synthetic prompt when user sent files but no caption.
        if (!text) {
          effectiveText = "(使用者上傳了檔案但沒有附訊息) 請先讀附件,簡述每份內容並問使用者想用它做什麼。";
        }
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

      const loadedEntries = loadChannelTurns(channelId, sessionThreadTs);
      const initialMessages = entriesToMessages(loadedEntries);
      const initialKeys = new Set(
        initialMessages.map((m) => `${m.role} ${m.content}`),
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
        text: effectiveText,
        userId,
        session,
        saveSession: (s) => {
          const newMessages = s.messages.filter(
            (m) => !initialKeys.has(`${m.role} ${m.content}`),
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
            ...(m.role === "user" && m.content === effectiveText
              ? { userId }
              : {}),
          }));
          appendChannelTurns(channelId, sessionThreadTs, entries);
        },
        attachment,
      });
      // Touch channel meta so listRecentChannels picks it up for the
      // offline / online broadcast list.
      saveChannelMeta(meta);
      return;
    }

    // Active-case branch: attachments are not supported — post a brief note
    // and proceed with the case turn as usual. Do NOT ingest.
    if (files && files.length > 0) {
      // Audio-specific rejection: inform the user that audio requires DM.
      if (isAudioMessage(files)) {
        await this.web.chat
          .postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: "_(音訊在 case 模式下不支援，請在 DM 直接傳送音訊檔案)_",
          })
          .catch(() => {});
      }
      await this.web.chat
        .postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: "_(附件在 case 模式下不支援，已忽略)_",
        })
        .catch(() => {});
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

    // Case-mode parity with free-chat: wrap the LLM call in the
    // context-too-long retry so a bloated case history force-prunes and
    // retries (with a :scissors: notice) instead of dead-ending on
    // `msg_too_long`, and a genuinely-too-long conversation gets the
    // same friendly "open a new thread" guidance rather than a generic
    // internal-error string. The getter/setter view lets
    // forcePruneToMinimum's `messages = [...]` reassignment propagate
    // back onto the case file.
    const caseSession: ContextRetrySession = {
      get messages(): ChatMessage[] {
        return c.messages;
      },
      set messages(v: ChatMessage[]) {
        c.messages = v;
      },
      approxTokens: approxTokensFor(c.messages),
    };
    const retry = await chatWithContextRetry({
      llm: this.llm,
      systemPrompt: PROMPT_CASE,
      buildMessages: () => c.messages,
      session: caseSession,
      actor: userId,
      retrievalAtoms: 0,
      phase: "first-call",
    });
    if (!retry.ok) {
      const errText =
        retry.kind === "context"
          ? ":x: 對話太長，請開新 thread 重新提問"
          : `:warning: pmk 內部錯誤：${(retry.error as Error).message}`;
      await this.web.chat
        .update({
          channel: channelId,
          ts: String(placeholder.ts),
          text: errText,
        })
        .catch(() => {});
      return;
    }
    const response = retry.full;
    const visible = stripCaseUpdateBlock(response);
    c.messages.push({ role: "assistant", content: visible });

    const { actions } = parseCaseUpdate(response);
    const summaries = applyCaseUpdate(c, actions);
    saveCase(c, dir);
    saveChannelMeta(meta);

    await this.web.chat.update({
      channel: channelId,
      ts: String(placeholder.ts),
      text: retry.scissorsPrefix + truncateForSlack(markdownToMrkdwn(visible)),
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
}
