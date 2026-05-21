/**
 * Escalation flow coordinator (v0.13 tranche 2).
 *
 * Three concerns the v0.7 baseline carried on `SlackAdapter` itself:
 *
 *  1. **Outbound escalation** — model emits an `escalate` directive,
 *     adapter picks an IT/domain contact pool, @-mentions the
 *     effective members (filtering out the asker themselves), and
 *     persists a pending-escalation marker so the next IT reply in
 *     that thread is treated as the expert answer.
 *  2. **Inbound absorb** — an IT contact replies in the escalated
 *     thread; this code extracts a knowledge atom via the LLM and
 *     saves it to `~/.pmk/knowledge/`, then posts a `:hourglass:`
 *     pending notice anchored for ✅/❌ reaction approval.
 *  3. **Asker follow-up synthesis** — after the absorb lands, post a
 *     one-shot synthesised reply tagging the original asker so they
 *     don't have to re-ask.
 *
 * Behaviour is byte-equivalent to the pre-extraction methods on
 * `SlackAdapter`; the harness's mra-ask + reaction-approval tests
 * exercise the new module transitively.
 */
import type { WebClient } from "@slack/web-api";
import type { GatewayConfig } from "../config";
import {
  pickAudience,
  pickEffectiveEscalationPool,
  pickEscalationPool,
} from "../config";
import {
  clearThreadEscalation,
  loadThreadEscalation,
  saveThreadEscalation,
} from "../session-store";
import { appendGatewayEvent } from "../events";
import { extractKnowledgeAtom } from "../extractor";
import {
  saveAtom,
  type KnowledgeAtom,
} from "../knowledge";
import { pickGatewayPrompt } from "@pmk/shared";
import type { LlmProvider } from "../../llm";
import { parseEscalate, stripEscalateBlock } from "../escalate";
import { stripMraAskBlock } from "../mra-ask";
import { stripCaseUpdateBlock } from "../../case";
import {
  markdownToMrkdwn,
  truncateForSlack,
} from "../formatters";

/** Subset of `KnowledgeAtom` the asker-synthesis follow-up reads. */
type KnowledgeAtomLike = Pick<KnowledgeAtom, "question" | "answer" | "summary">;

/** Re-export for slack/index.ts → drop the `parseEscalate` import dance. */
export { parseEscalate };

export interface EscalationCoordinatorOptions {
  web: WebClient;
  config: GatewayConfig;
  onLog: (msg: string) => void;
  llm: LlmProvider;
}

export class EscalationCoordinator {
  constructor(private readonly opts: EscalationCoordinatorOptions) {}

  /**
   * Emit the outbound escalation: pick the effective pool, post the
   * @-mention (or a config-hint when the pool is empty / would tag
   * the asker), persist the pending marker, append the
   * `escalate.triggered` audit event.
   *
   * Returns nothing — the caller posts no Slack reply of its own.
   */
  async escalate(args: {
    channelId: string;
    threadTs: string;
    askerUserId: string;
    request: { repo?: string; question: string; reason?: string };
  }): Promise<void> {
    const { channelId, threadTs, askerUserId, request } = args;
    const { web, config, onLog } = this.opts;
    const pool = pickEscalationPool(config, request.repo);
    // v0.8.2 (#30): filter out the asker themselves — @-mentioning
    // the person who just asked is useless and creates the weird
    // "<@U_asker> 想麻煩你補充..." artefact when the pool only
    // happens to contain them.
    const effectivePool = pickEffectiveEscalationPool(
      config,
      request.repo,
      askerUserId,
    );

    if (effectivePool.length === 0) {
      // Two distinct config gaps land here:
      //   - pool is genuinely empty (host hasn't run `pmk gateway escalation add`)
      //   - pool resolves to [askerUserId] only (would tag self)
      onLog(
        `escalate requested (repo=${request.repo ?? "—"}) but no usable contacts ` +
          `(pool=[${pool.join(",")}], asker=${askerUserId}); ` +
          `posting config-hint instead of @-mention`,
      );
      const scopeLabel = request.repo ? `\`${request.repo}\`` : "default";
      await web.chat
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
          onLog(
            `failed to post escalation config-hint: ${(err as Error).message}`,
          );
        });
      // Deliberately do NOT save the pending marker — there's nobody
      // to wait for, so an absorb hook would never fire.
      return;
    }

    const mentions = effectivePool.map((id) => `<@${id}>`).join(" ");
    const reasonLine = request.reason ? `\n_原因_：${request.reason}` : "";
    await web.chat
      .postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `${mentions} 想麻煩你補充，pmk 沒有足夠 context 回答這題：\n> ${request.question}${reasonLine}\n\n回覆時請記得 \`@pmk\` 一下（例：\`@pmk 答案是…\`），這樣 pmk 才接得到你的回覆並吸收成 knowledge atom，之後同樣問題就能直接答出來。`,
      })
      .catch((err) => {
        onLog(
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
  async maybeAbsorbReply(args: {
    channelId: string;
    threadTs: string;
    contributorUserId: string;
    answerText: string;
  }): Promise<boolean> {
    const { channelId, threadTs, contributorUserId, answerText } = args;
    const { web, onLog, llm } = this.opts;
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
    onLog(
      `escalation reply received from ${contributorUserId} in ${channelId}/${threadTs}; extracting`,
    );
    let atom: Awaited<ReturnType<typeof extractKnowledgeAtom>>;
    try {
      atom = await extractKnowledgeAtom(llm, {
        question: esc.question,
        reason: esc.reason,
        expertAnswer: answerText,
        scope: esc.scope ?? "general",
        threadKey: `${channelId}:${threadTs}`,
        contributorUserId,
      });
    } catch (err) {
      onLog(`extractor failed: ${(err as Error).message}`);
      return true;
    }
    if (!atom) {
      onLog("extractor returned no atom (parse failure?); skipping save");
      return true;
    }
    try {
      // First save: atom in pending without approval anchor.
      const file = saveAtom(atom);
      onLog(`absorbed knowledge atom (pending) → ${file}`);
      appendGatewayEvent({
        type: "escalate.absorbed",
        channelId,
        threadTs,
        atomId: atom.id,
      });
      const idShort = atom.id.split("-").slice(0, 2).join("-");
      const post = await web.chat
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
          onLog(
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
      onLog(`failed to save atom: ${(err as Error).message}`);
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
      onLog(`post-absorb synthesis failed: ${(err as Error).message}`),
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
    const { web, config, onLog, llm } = this.opts;
    const audience = pickAudience(config, askerUserId, channelId);
    const systemPrompt = pickGatewayPrompt(
      audience,
      config.audience.domainExamples,
    );
    const synthMessage =
      `IT 同事剛在這條 thread 補上了答案，請依以下事實 synthesise 一段回覆給原本提問的同事 <@${askerUserId}>。語氣依你的 audience prompt。\n\n` +
      `原始問題：${atom.question}\n\n` +
      `IT 答案（verbatim）：\n${atom.answer}\n\n` +
      `Summary：${atom.summary ?? "(none)"}\n\n` +
      `不要再 emit 任何 mra-ask 或 escalate block；這只是把答案傳給原問者。`;
    let reply: string;
    try {
      reply = await llm.chat(
        systemPrompt,
        [{ role: "user", content: synthMessage }],
        { onToken: () => {} },
      );
    } catch (err) {
      onLog(`synth llm call failed: ${(err as Error).message}`);
      return;
    }
    const visible = stripEscalateBlock(
      stripMraAskBlock(stripCaseUpdateBlock(reply)),
    );
    await web.chat
      .postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `<@${askerUserId}> ${truncateForSlack(markdownToMrkdwn(visible))}`,
      })
      .catch((err) =>
        onLog(
          `failed to post synthesised follow-up: ${(err as Error).message}`,
        ),
      );
  }
}
