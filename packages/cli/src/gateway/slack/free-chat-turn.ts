/**
 * Free-chat turn runner (v0.13 tranche 3).
 *
 * The orchestration layer that ties together everything between
 * "user said something" and "bot's reply lands in Slack":
 *
 *  1. **Seed** — on first turn, inject PKB context from
 *     `config.defaultIngest` (capped per v0.11.1).
 *  2. **Retrieval** — pull relevant knowledge atoms and inject as
 *     ephemeral context (not persisted).
 *  3. **Prune** — trim session before the LLM call so a bloated
 *     history doesn't trigger `msg_too_long` (v0.11.1 pre-call
 *     pattern).
 *  4. **First-call** — `chatWithContextRetry` wraps the LLM call;
 *     on `PmkContextTooLongError` it force-prunes and retries.
 *  5. **mra-ask round** — if the model emits an `mra-ask` directive,
 *     run the subprocess and call the LLM again to synthesise.
 *  6. **escalate** — if the (possibly synthesised) response emits
 *     an `escalate` directive, hand off to `EscalationCoordinator`.
 *  7. **Reply** — strip directives, persist to session, update the
 *     placeholder.
 *
 * Behaviour is byte-equivalent to the pre-extraction
 * `SlackAdapter.runFreeChatTurn` + `handleMraAskRound` +
 * `synthesiseAfterMra` private methods; the v0.13 harness's DM
 * happy-path, mra-ask escalate-round, and msg_too_long hardening
 * tests all transitively cover the new module without modification.
 */
import type { WebClient } from "@slack/web-api";
import type { ChatMessage } from "@pmk/shared";
import { pickGatewayPrompt } from "@pmk/shared";
import type { GatewayConfig } from "../config";
import { pickAudience } from "../config";
import type { LlmProvider } from "../../llm";
import { PmkContextTooLongError } from "../../llm/claude-agent";
import type {
  mraDoctor as mraDoctorImpl,
  runMraAsk as runMraAskImpl,
} from "../../adapters/mra";
import { appendGatewayEvent } from "../events";
import { createLastLineThrottle } from "../throttle";
import { sanitizeProgressLine } from "./progress";
import { parseMraAsk, stripMraAskBlock } from "../mra-ask";
import { parseEscalate, stripEscalateBlock } from "../escalate";
import { stripCaseUpdateBlock } from "../../case";
import { chatWithContextRetry } from "./context-retry";
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
import {
  searchAtoms,
  formatAtomsForInjection,
} from "../knowledge";
import {
  markdownToMrkdwn,
  truncateForSlack,
} from "../formatters";
import { EscalationCoordinator } from "./escalation";

/**
 * Structural shape of any session the free-chat runner can mutate —
 * `UserSession` (DM) and the channel-log-derived in-memory session
 * both satisfy this. Defined here (alongside its only consumer)
 * rather than in `slack/index.ts` to avoid a circular import.
 */
export interface FreeChatSession {
  messages: ChatMessage[];
  turns: number;
  approxTokens: number;
}

export interface FreeChatTurnRunnerOptions {
  web: WebClient;
  config: GatewayConfig;
  onLog: (msg: string) => void;
  llm: LlmProvider;
  mraDoctor: typeof mraDoctorImpl;
  runMraAsk: typeof runMraAskImpl;
  escalation: EscalationCoordinator;
}

export class FreeChatTurnRunner {
  constructor(private readonly opts: FreeChatTurnRunnerOptions) {}

  /**
   * Run a single free-chat turn end-to-end. Generic over the session
   * shape so DM and channel-log callers can pass their own
   * `saveSession` semantics without this layer caring.
   */
  async run<S extends FreeChatSession>(args: {
    channelId: string;
    threadTs: string;
    text: string;
    userId: string;
    session: S;
    saveSession: (s: S) => void;
  }): Promise<void> {
    const { channelId, threadTs, text, userId, session, saveSession } = args;
    const { web, config, onLog, llm } = this.opts;

    // First turn: seed the conversation with PKB context from
    // config.defaultIngest (e.g. mra:--all). Without this the model
    // truthfully says it has no idea about the user's codebase even
    // though we configured the ingest spec at gateway init.
    //
    // v0.11.1: cap the seed at SEED_CAP chars so an `mra:--all` against a
    // large multi-repo workspace can't single-handedly exhaust the
    // model's input window. Emits a `message.capped` event when capping
    // fires so operators can see how often the cap is biting.
    if (session.messages.length === 0 && config.defaultIngest) {
      const seedRaw = buildIngestSeed(
        config.defaultIngest,
        config.mraWorkspace,
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
      onLog(
        `pruned session: dropped ${pruneReport.droppedPairs} turn-pair(s); now ${pruneReport.tokensAfter} approx tokens`,
      );
    }

    const placeholder = await web.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: ":hourglass_flowing_sand: thinking…",
    });

    const audience = pickAudience(config, userId, channelId);
    const systemPrompt = pickGatewayPrompt(audience);

    // T11: wrap llm.chat in the context-too-long retry helper. The
    // buildMessages closure includes the new user turn at the tail so
    // the LLM sees it on both attempts; we deliberately do NOT push it
    // onto session.messages until AFTER the retry succeeds, so a failed
    // turn doesn't pollute persisted history (and so forcePruneToMinimum
    // operates on a coherent paired-history shape).
    const retryResult = await chatWithContextRetry({
      llm,
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
      await web.chat.update({
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
          await web.chat.update({
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
      await this.opts.escalation.escalate({
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

    await web.chat.update({
      channel: channelId,
      ts: String(placeholder.ts),
      text: scissorsPrefix + truncateForSlack(markdownToMrkdwn(visible)),
    });
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
    retrievalPrefix: ChatMessage[];
    retrievalAtoms: number;
    firstResponse: string;
    request: { repo: string; question: string };
    systemPrompt: string;
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
    const { web, config, onLog, mraDoctor, runMraAsk } = this.opts;
    const doctor = mraDoctor({ workspace: config.mraWorkspace });
    if (!doctor.ok || !doctor.workspace) {
      onLog(`mra-ask short-circuited: ${doctor.reason ?? "(no reason)"}`);
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
    await web.chat
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
        const safe = sanitizeProgressLine(line);
        void web.chat
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

    onLog(`mra ask repo=${request.repo} q=${truncate(request.question, 120)}`);
    const mraStartMs = Date.now();
    const result = await runMraAsk(
      {
        repo: request.repo,
        question: request.question,
        cwd: doctor.workspace,
      },
      {
        onRetry: (attempt) => {
          onLog(
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
      onLog(`mra ask succeeded on attempt ${result.attempts}`);
    }
    if (!result.ok) {
      // Diagnostic-friendly: surface stderr / partial stdout so the
      // host operator can see WHY mra exited non-zero. Without this,
      // failures collapse to Node's default "Command failed: <argv>"
      // which is useless when triaging mra integration issues.
      onLog(`mra ask failed: ${result.reason ?? "(no reason)"}`);
      if (result.stderr.trim()) {
        onLog(`mra ask stderr: ${truncate(result.stderr.trim(), 600)}`);
      }
      if (result.stdout.trim()) {
        onLog(
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
   * how to surface the failure to Slack (see `run`).
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
    const { llm } = this.opts;
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

    const retryResult = await chatWithContextRetry({
      llm,
      systemPrompt,
      buildMessages: () => [...retrievalPrefix, ...session.messages],
      session,
      actor,
      retrievalAtoms,
      phase: "synthesise",
      chatOptions: { onToken: () => {} },
    });

    if (!retryResult.ok) {
      if (retryResult.kind === "context") {
        throw new PmkContextTooLongError(retryResult.secondError);
      }
      throw retryResult.error;
    }

    return { full: retryResult.full, scissorsPrefix: retryResult.scissorsPrefix };
  }
}
