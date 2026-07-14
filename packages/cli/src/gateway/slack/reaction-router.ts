/**
 * Routes a Slack `reaction_added` event to the right coordinator action:
 *   :cr:            → PR review           (on a user's PR-request message)
 *   :a:             → PR approve          (on a user's PR-request message)
 *   📚              → save audio summary as a knowledge atom (bot message)
 *   ✅ / ❌         → approve / reject a pending atom (bot message, contributor-gated)
 *   :ticket:        → open a GitHub issue from a candidate (bot message)
 *   👎              → mark cited atoms questioned (bot reply)
 *
 * Extracted from SlackAdapter so the emoji→action dispatch is one testable unit;
 * the adapter passes its coordinators + web client + config in as deps.
 */
import type { WebClient } from "@slack/web-api";
import type { GatewayConfig } from "../config";
import { approveAtom, findAtomByApprovalMessage, rejectAtom } from "../knowledge";
import { bumpQuestioned } from "../atom-telemetry";
import { readGatewayEvents } from "../events";
import type { ReviewCoordinator } from "./review";
import type { AudioCoordinator } from "../audio/coordinator";
import type { IssueCoordinator } from "./issue";
import type { Slack } from "./slack-events";

export interface ReactionRouterDeps {
  web: WebClient;
  config: GatewayConfig;
  botInfo: { botUserId: string };
  review: Pick<ReviewCoordinator, "fromReaction" | "fromApproveReaction">;
  audio: Pick<AudioCoordinator, "fromApproval">;
  issue: Pick<IssueCoordinator, "fromCandidate">;
  onLog: (msg: string) => void;
}

export async function routeReactionAdded(
  payload: Slack.ReactionEventPayload,
  deps: ReactionRouterDeps,
): Promise<void> {
  await payload.ack?.().catch(() => {});

  const event = payload?.event;
  if (!event) return;

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
  if (deps.config.blocklist.includes(reactorUserId)) return;

  // :cr: → PR review. Unlike approval/ticket reactions, this lands on a
  // USER's message (the PR-request post), so it is handled BEFORE the
  // bot-message guard (which only admits reactions on the bot's own messages).
  if (reaction === "cr") {
    await deps.review.fromReaction({ channelId, messageTs, reactorUserId });
    return;
  }
  if (reaction === "a") {
    await deps.review.fromApproveReaction({ channelId, messageTs, reactorUserId });
    return;
  }

  // Remaining reactions (approval / ticket / citation-feedback) only apply
  // to the bot's own messages (item_user is the author of the reacted-to message).
  if (event.item_user !== deps.botInfo.botUserId) return;

  // 📚 on a bot audio-summary message → save it to the knowledge base.
  if (reaction === "books") {
    if (await deps.audio.fromApproval({ channelId, messageTs, reactorUserId })) return;
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
    await deps.issue.fromCandidate({ channelId, anchorTs: messageTs, reactorUserId });
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
    deps.onLog(
      `reaction-approval ignored: ${reactorUserId} is not the atom contributor (${found.atom.source.contributorUserId})`,
    );
    return;
  }

  // thumbsdown is citation-feedback only; it must never act as an
  // approval-reject on a pending-atom anchor.
  if (!isApprove && !isReject) return;

  if (isApprove) {
    const promoted = approveAtom(found.atom.id);
    deps.onLog(
      `reaction-approval: ${found.atom.id} approved via :${reaction}: from ${reactorUserId}`,
    );
    const tags = promoted?.tags?.length ? promoted.tags.join(", ") : "—";
    await deps.web.chat
      .postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: `:books: 已生效（標籤：${tags}），下次同類問題會自動帶進來。`,
      })
      .catch(() => {});
  } else {
    const ok = rejectAtom(found.atom.id);
    deps.onLog(
      `reaction-approval: ${found.atom.id} rejected via :${reaction}: from ${reactorUserId} (deleted=${ok})`,
    );
    await deps.web.chat
      .postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: `:wastebasket: 已捨棄，atom 檔案已刪除。`,
      })
      .catch(() => {});
  }
}
