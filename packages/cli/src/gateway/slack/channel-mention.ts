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
}

export class ChannelMentionHandler {
  private readonly web: WebClient;
  private readonly llm: LlmProvider;
  private readonly freeChatTurn: FreeChatTurnRunner;
  private readonly slashCommand: SlashCommandHandler;

  constructor(opts: ChannelMentionHandlerOptions) {
    this.web = opts.web;
    this.llm = opts.llm;
    this.freeChatTurn = opts.freeChatTurn;
    this.slashCommand = opts.slashCommand;
  }

  async run(args: {
    channelId: string;
    userId: string;
    text: string;
    threadTs: string;
    sessionThreadTs?: string;
  }): Promise<void> {
    const { channelId, userId, text, threadTs, sessionThreadTs } = args;

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
        text,
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
