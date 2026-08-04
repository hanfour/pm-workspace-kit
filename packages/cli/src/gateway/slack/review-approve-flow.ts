/**
 * The approve-authorisation flow: turning an admin's in-thread `approve` into
 * a real GitHub APPROVE, or an honest refusal.
 *
 * Extracted from ReviewCoordinator, where it sat contiguously at
 * review.ts:543-802 sharing no mutable state with the review path — the two
 * communicate only through the approval offer on disk.
 */
import type { GatewayConfig } from "../config";
import {
  resolveReviewConfig,
  resolveGithubToken,
  resolveReviewGhToken,
  isAdmin,
} from "../config";
import { appendGatewayEvent } from "../events";
import type { ApprovalReservation } from "../review-approval";
import {
  consumeApprovalReservation,
  markApprovalPendingReconcile,
  releaseApprovalReservation,
} from "../review-approval";
import { AUTOMATIC_APPROVAL_RELEASE_READY, findProtectionExemption } from "../review-policy";
import { withAuthorizationLock } from "../authorization-lock";
import type { ReviewGateway } from "./review";
import { protectionNotReadyMessage } from "./review";

export interface ApproveFlowDeps {
  gateway: ReviewGateway;
  /**
   * MUST stay a function. publishReservation's three revision fences re-read
   * live config to detect a policy change landing mid-approve; a snapshot
   * would make each fence compare a value against itself and always pass.
   */
  currentConfig: () => GatewayConfig;
  fetchMessageText: (ch: string, ts: string) => Promise<string | undefined>;
  reply: (ch: string, threadTs: string, text: string) => Promise<void>;
}

export class ApproveFlow {
  constructor(private readonly deps: ApproveFlowDeps) {}

  async publishReservation(reservation: ApprovalReservation, actorUserId: string): Promise<void> {
    const { gateway } = this.deps;
    let mutationStarted = false;
    try {
      if (reservation.refs.length !== 1)
        throw new Error("multi-PR approval must be confirmed in separate review threads");
      // #90: the whole authorize→preflight→POST section runs under the shared
      // authorization lock, so no config write can land between the policy
      // reads (the revision fences below, kept as defense-in-depth) and the
      // actual GitHub mutation. A concurrent writer either commits before the
      // first read (fences reject) or blocks until the POST completes.
      await withAuthorizationLock(async () => {
      for (const ref of reservation.refs) {
        const live = this.deps.currentConfig();
        const review = resolveReviewConfig(live.review);
        const slug = `${ref.owner}/${ref.repo}`;
        if (!AUTOMATIC_APPROVAL_RELEASE_READY || !review.enabled || !review.approval.enabled || !isAdmin(live, actorUserId) || live.blocklist.includes(actorUserId))
          throw new Error("approval policy or admin authorization was revoked");
        if (review.repoAllowlist && !review.repoAllowlist.includes(slug))
          throw new Error("repository is no longer allowlisted");
        const token = resolveReviewGhToken(live.review) ?? resolveGithubToken(live.github);
        const policyRevision = JSON.stringify({
          admins: [...live.admins].sort(), blocklist: [...live.blocklist].sort(), review,
          actorUserId, slug, token,
        });
        const authUser = await gateway.getAuthUser({ token });
        if (!authUser || (review.expectedGhUser && authUser !== review.expectedGhUser))
          throw new Error("GitHub identity is not approval-ready");
        // Freshness pin = headSha (the exact code) + baseRef (the target).
        // Deliberately NOT updatedAt: our own protocol-v1 review post bumps it,
        // as does any teammate comment — comparing it invalidated every offer
        // the moment the review was posted (found on the first live approve).
        // contextVersion stays recorded on the offer for audit only.
        const before = await gateway.getPrHead({ slug, pr: ref.number, token });
        if (!before || before.sha !== ref.headSha || before.baseRef !== ref.baseRef)
          throw new Error("PR head, base, or review context changed after review");
        // The probe still runs on every approve; the exemption gates the THROW,
        // not the check. Keeping the measurement means the disclosure below
        // asserts only what we actually observed, and an obsolete waiver
        // announces itself. approvalProtectionReady never throws (false on
        // error), so a network blip degrades to "still unprotected".
        const exemption = findProtectionExemption(review.approval, slug);
        const protectionReady = await gateway.approvalProtectionReady({ slug, branch: ref.baseRef, token });
        // Ungated auto-allow: only when the flag is on and the repo is neither
        // protected nor exempt. The probe distinguishes ungated (false) from
        // unreadable (undefined) — only a positive false may allow; undefined
        // fails closed. Runs at most once, and never on the protected/exempt paths.
        let ungatedAllow = false;
        let gateStatus: boolean | undefined;
        let gateProbed = false;
        if (review.approval.allowWhenNoReviewGate && !protectionReady && !exemption) {
          gateProbed = true;
          gateStatus = await gateway.reviewGateStatus({ slug, branch: ref.baseRef, token });
          ungatedAllow = gateStatus === false;
        }
        if (!protectionReady && !exemption && !ungatedAllow)
          throw new Error(protectionNotReadyMessage(slug, ref.baseRef, gateStatus, gateProbed));
        const exemptionInEffect = !protectionReady && !!exemption;
        const approvalBasis: "protected" | "exempt" | "ungated" =
          protectionReady ? "protected" : exemptionInEffect ? "exempt" : "ungated";
        const finalLive = this.deps.currentConfig();
        const finalReview = resolveReviewConfig(finalLive.review);
        const finalToken = resolveReviewGhToken(finalLive.review) ?? resolveGithubToken(finalLive.github);
        const finalRevision = JSON.stringify({
          admins: [...finalLive.admins].sort(), blocklist: [...finalLive.blocklist].sort(), review: finalReview,
          actorUserId, slug, token: finalToken,
        });
        if (finalRevision !== policyRevision || finalToken !== token)
          throw new Error("approval policy changed during preflight");
        const finalActor = await gateway.getAuthUser({ token: finalToken });
        const finalHead = await gateway.getPrHead({ slug, pr: ref.number, token: finalToken });
        // Same pin as the first preflight: sha + baseRef, never updatedAt.
        if (finalActor !== authUser || !finalHead || finalHead.sha !== ref.headSha || finalHead.baseRef !== ref.baseRef)
          throw new Error("approval identity or PR changed during final preflight");
        const postFence = this.deps.currentConfig();
        const postFenceReview = resolveReviewConfig(postFence.review);
        const postFenceToken = resolveReviewGhToken(postFence.review) ?? resolveGithubToken(postFence.github);
        const postFenceRevision = JSON.stringify({
          admins: [...postFence.admins].sort(), blocklist: [...postFence.blocklist].sort(), review: postFenceReview,
          actorUserId, slug, token: postFenceToken,
        });
        if (postFenceRevision !== policyRevision || postFenceToken !== token)
          throw new Error("approval policy changed immediately before publication");
        mutationStarted = true;
        const posted = await gateway.createPullRequestApproval({
          slug,
          pr: ref.number,
          commitId: ref.headSha,
          token,
          body: `PMK approval for MRA artifact ${ref.artifactSha256}`,
        });
        const after = await gateway.getPrHead({ slug, pr: ref.number, token });
        if (!after || after.sha !== ref.headSha)
          throw new Error(`approval ${posted.reviewId} became stale during publication`);
        appendGatewayEvent({
          type: "review.approved",
          actor: actorUserId,
          repo: slug,
          pr: ref.number,
          commit: ref.headSha,
          reviewId: posted.reviewId,
          approvalBasis,
          exemptionReason: approvalBasis === "exempt" ? exemption!.reason : undefined,
        });
        const approvedLine = `:white_check_mark: 已真實 approve ${slug}#${ref.number}（commit \`${ref.headSha.slice(0, 7)}\`，GitHub review #${posted.reviewId}）。`;
        const riskLine = approvalBasis === "exempt"
          ? `\n:warning: 此 repo 未啟用 dismiss-stale/require-last-push：後續新 push 不會讓這個 approval 失效，可能被用來 merge 未經 review 的 commit。豁免理由：${exemption!.reason}`
          : "";
        const ungatedLine = approvalBasis === "ungated"
          ? `\n:information_source: 此 repo 的 ruleset 未要求任何核准，approve 僅為 review 簽核紀錄，不影響 merge 條件。`
          : "";
        const obsoleteLine = protectionReady && exemption
          ? `\n:information_source: ${slug} 的 protection 豁免已不再需要（branch 現已同時啟用 dismiss-stale 與 require-last-push），可以從 config 移除。`
          : "";
        await this.deps.reply(reservation.channelId, reservation.threadTs, `${approvedLine}${riskLine}${ungatedLine}${obsoleteLine}`);
      }
      });
      consumeApprovalReservation(reservation);
    } catch (err) {
      if (mutationStarted) {
        markApprovalPendingReconcile(reservation);
        await this.deps.reply(reservation.channelId, reservation.threadTs,
          `:warning: approve 結果無法確定，已進入 pending reconcile，不會自動重送：${(err as Error).message}`);
      } else {
        releaseApprovalReservation(reservation);
        await this.deps.reply(reservation.channelId, reservation.threadTs,
          `:no_entry: approve preflight 未通過，授權尚未消耗：${(err as Error).message}`);
      }
    }
  }
}
