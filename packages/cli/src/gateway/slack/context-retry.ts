import type { ChatMessage } from "@pmk/shared";
import { forcePruneToMinimum } from "../messaging";
import { appendGatewayEvent } from "../events";
import { PmkContextTooLongError } from "../../llm/claude-agent";
import type { ChatOptions, LlmProvider } from "../../llm";

/**
 * Session shape this helper mutates. Mirrors the FreeChatSession subset we
 * need without dragging in the full type from `slack/index.ts` so the
 * helper stays unit-testable in isolation. `forcePruneToMinimum` rewrites
 * `messages` and updates `approxTokens` in place.
 */
export interface ContextRetrySession {
  messages: ChatMessage[];
  approxTokens: number;
}

/**
 * Which budget wall the retry is firing at. Recorded on the
 * `context.exceeded` event so audits can tell "first call" prompt blow-ups
 * apart from synthesise-round mra-result fold-in blow-ups.
 */
export type ContextRetryPhase = "first-call" | "synthesise";

export interface ContextRetryArgs {
  llm: Pick<LlmProvider, "chat">;
  systemPrompt: string;
  /**
   * Builds the message array to send. Called twice — once for the initial
   * attempt and once after force-prune. The second call must reflect the
   * post-force-prune session state, which is why this is a closure rather
   * than a pre-built array.
   */
  buildMessages: () => ChatMessage[];
  session: ContextRetrySession;
  actor: string;
  retrievalAtoms: number;
  phase: ContextRetryPhase;
  chatOptions?: ChatOptions;
}

export type ContextRetryResult =
  | { ok: true; full: string; scissorsPrefix: string }
  | {
      ok: false;
      kind: "context";
      firstError: PmkContextTooLongError;
      secondError: unknown;
    }
  | { ok: false; kind: "other"; error: unknown };

/**
 * Wraps `llm.chat` with a context-too-long retry path. On
 * `PmkContextTooLongError`: emits `context.exceeded`, force-prunes the
 * session, emits `context.force-pruned`, then retries. On retry success
 * returns the reply with a `:scissors: 對話過長，已自動裁掉 N 輪舊訊息\n\n`
 * prefix the caller can prepend to the visible Slack reply. Other errors
 * propagate as `{ ok: false, kind: "other" }` so the caller can keep its
 * existing non-context error display.
 *
 * Note: this helper does NOT touch any Slack APIs. It owns only the
 * audit-event side effects + the session mutation produced by
 * `forcePruneToMinimum`. Slack `chat.update` for error display stays at
 * the call site so the helper remains usable from non-Slack contexts.
 */
export async function chatWithContextRetry(
  args: ContextRetryArgs,
): Promise<ContextRetryResult> {
  const {
    llm,
    systemPrompt,
    buildMessages,
    session,
    actor,
    retrievalAtoms,
    phase,
    chatOptions,
  } = args;
  const opts: ChatOptions = chatOptions ?? { onToken: () => {} };

  try {
    const full = await llm.chat(systemPrompt, buildMessages(), opts);
    return { ok: true, full, scissorsPrefix: "" };
  } catch (err) {
    if (!(err instanceof PmkContextTooLongError)) {
      return { ok: false, kind: "other", error: err };
    }
    appendGatewayEvent({
      type: "context.exceeded",
      actor,
      sessionTokensBefore: session.approxTokens,
      retrievalAtoms,
      phase,
    });
    const dropped = forcePruneToMinimum(session);
    appendGatewayEvent({
      type: "context.force-pruned",
      actor,
      droppedPairs: dropped,
      tokensAfter: session.approxTokens,
    });

    try {
      const full = await llm.chat(systemPrompt, buildMessages(), opts);
      return {
        ok: true,
        full,
        scissorsPrefix: `:scissors: 對話過長，已自動裁掉 ${dropped} 輪舊訊息\n\n`,
      };
    } catch (err2) {
      return {
        ok: false,
        kind: "context",
        firstError: err,
        secondError: err2,
      };
    }
  }
}
