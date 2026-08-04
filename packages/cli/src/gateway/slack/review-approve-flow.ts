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
import { appendGatewayEvent, readGatewayEvents } from "../events";
import type { ApprovalReservation } from "../review-approval";
import {
  consumeApprovalReservation,
  listPendingApprovalReconciliations,
  markApprovalPendingReconcile,
  releaseApprovalReservation,
  reserveApprovalOffer,
  resolveApprovalReconciliation,
} from "../review-approval";
import { parsePrRefs, type PrRef } from "../pr-ref";
import { AUTOMATIC_APPROVAL_RELEASE_READY, findProtectionExemption } from "../review-policy";
import { withAuthorizationLock } from "../authorization-lock";
import type { ReviewGateway } from "./review";
import { protectionNotReadyMessage } from "../review-policy";

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

  /**
   * Public, deliberately: this is the seam the fence tests drive directly
   * (approve-flow-fences.test.ts). `confirmInThread` is the only production
   * caller and the guard chain callers must not skip lives there — but the
   * fences below independently re-check admin, allowlist and approval-enabled,
   * so a direct call cannot bypass authorisation, only the offer bookkeeping.
   * The module is internal: no barrel, no package export.
   */
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

  /**
   * `approve` posted in a `:cr:` review thread → explicit authorization to run
   * the approve path for the same PR. This keeps `:cr:` review-only while giving
   * users a clear one-step confirmation when the review result is approvable.
   */
  async confirmInThread(args: {
    channelId: string;
    threadTs: string;
    userId: string;
    /**
     * The confirmation text, when available. A PR link inside it never selects
     * the PR — the thread's offer does — but a link naming a DIFFERENT PR means
     * the admin thinks they are approving something else, so we refuse.
     */
    text?: string;
  }): Promise<void> {
    const config = this.deps.currentConfig();
    const review = resolveReviewConfig(config.review);
    if (!review.enabled) return;
    if (!AUTOMATIC_APPROVAL_RELEASE_READY || !review.approval.enabled) {
      await this.deps.reply(args.channelId, args.threadTs, ":lock: GitHub automatic approval 目前為安全停用狀態；這個 review 不會執行 approve。");
      return;
    }
    if (!isAdmin(config, args.userId)) {
      await this.deps.reply(args.channelId, args.threadTs, ":no_entry: approve 授權只接受 PMK admin；請 admin 在此 thread 回覆 `approve`。");
      return;
    }
    const mismatch = await this.mismatchedConfirmationPr(args);
    if (mismatch) {
      await this.deps.reply(args.channelId, args.threadTs, mismatch);
      return;
    }
    const pending = listPendingApprovalReconciliations(args.channelId, args.threadTs);
    if (pending.length > 0) {
      const token = resolveReviewGhToken(config.review) ?? resolveGithubToken(config.github);
      const actor = review.expectedGhUser ?? await this.deps.gateway.getAuthUser({ token });
      if (!actor) {
        await this.deps.reply(args.channelId, args.threadTs, ":warning: pending approve 無法確認 GitHub identity，未自動重送。");
        return;
      }
      for (const item of pending) {
        const matches = await Promise.all(item.refs.map((ref) => this.deps.gateway.hasPullRequestApproval({
          slug: `${ref.owner}/${ref.repo}`, pr: ref.number, commitId: ref.headSha,
          artifactSha256: ref.artifactSha256, actor, token,
        })));
        if (matches.every((v) => v === true)) {
          resolveApprovalReconciliation(item, "consumed");
          await this.deps.reply(args.channelId, args.threadTs, ":information_source: 已由 GitHub review ledger 確認先前 approve 成功，不會重送。");
          return;
        }
        // A negative list result is not proof that a timed-out POST will never
        // become visible. Keep pending until an operator explicitly resolves it.
        if (matches.every((v) => v === false)) {
          await this.deps.reply(args.channelId, args.threadTs, ":warning: GitHub 尚未找到先前 approve，但為避免 eventual-consistency 重複送出，維持 pending reconcile，需由 operator 處理。");
          return;
        }
        await this.deps.reply(args.channelId, args.threadTs, ":warning: pending approve 對帳結果不完整，維持 pending reconcile，不會自動重送。");
        return;
      }
    }
    const reservation = reserveApprovalOffer(args.channelId, args.threadTs);
    if (!reservation?.refs.length) {
      await this.deps.reply(args.channelId, args.threadTs, await this.missingOfferMessage(args.channelId, args.threadTs));
      return;
    }
    await this.publishReservation(reservation, args.userId);
  }

  /**
   * Guards the intent behind a confirmation that carries a PR link. The thread's
   * offer selects what gets approved, so a link naming a different PR means the
   * admin is authorizing something other than what they believe. Returns the
   * refusal text, or null when there is nothing to object to.
   *
   * Runs BEFORE the offer is reserved, so a refused confirmation leaves the
   * offer intact and the admin can simply reply `approve` again.
   */
  private async mismatchedConfirmationPr(args: {
    channelId: string;
    threadTs: string;
    text?: string;
  }): Promise<string | null> {
    if (!args.text) return null;
    const named = parsePrRefs(args.text);
    if (named.length === 0) return null;
    const rootText = await this.deps.fetchMessageText(args.channelId, args.threadTs);
    const threadRefs = rootText ? parsePrRefs(rootText) : [];
    // No PR in the thread root to compare against — leave the decision to the
    // offer lookup rather than inventing a mismatch.
    if (threadRefs.length === 0) return null;
    const key = (r: PrRef) => `${r.owner}/${r.repo}#${r.number}`;
    const threadKeys = new Set(threadRefs.map(key));
    const stray = named.filter((r) => !threadKeys.has(key(r)));
    if (stray.length === 0) return null;
    return (
      `:no_entry: 你附的連結指向不同的 PR（${stray.map(key).join("、")}），` +
      `與這個 thread 正在處理的 ${[...threadKeys].join("、")} 不符。` +
      "為避免核准到未 review 的 PR，這次授權不會執行。\n" +
      "若要核准本 thread 的 PR，直接回覆 `approve`；" +
      "若要核准另一個 PR，請對它執行 `:cr: <PR 連結>` 後在該 thread 授權。"
    );
  }

  /**
   * The reply when `approve` finds no usable offer. Usually that means no review
   * has run — "complete a `:cr:` review first". But a review that finds blockers
   * posts CHANGES_REQUESTED and NEVER creates an offer, so telling the admin to
   * re-run a review they already ran is misleading. When the thread's PR was most
   * recently reviewed with blockers, name that as the real reason instead.
   */
  private async missingOfferMessage(channelId: string, threadTs: string): Promise<string> {
    const generic = ":information_source: 這個 thread 沒有有效、未使用的 approve offer。請先完成 `:cr: <PR 連結>` review；offer 使用一次或逾時後需重新 review。";
    const rootText = await this.deps.fetchMessageText(channelId, threadTs);
    if (!rootText) return generic;
    const review = resolveReviewConfig(this.deps.currentConfig().review);
    const refs = parsePrRefs(rootText, { cap: review.maxPrsPerTrigger });
    if (refs.length === 0) return generic;
    const posted = readGatewayEvents().filter((e) => e.type === "review.posted");
    for (const ref of refs) {
      const slug = `${ref.owner}/${ref.repo}`;
      // The MOST RECENT review.posted for this PR decides: a since-fixed PR
      // re-reviewed clean has a newer 0-blocker event and correctly falls through.
      const last = [...posted].reverse().find((e) => e.repo === slug && e.pr === ref.number) as
        | { status?: string; blockerCount?: number } | undefined;
      if (last && ((last.blockerCount ?? 0) >= 1 || last.status === "CHANGES_REQUESTED")) {
        const n = last.blockerCount ?? 0;
        const count = n >= 1 ? `${n} 個 blocker` : "blocker";
        return `:information_source: ${slug}#${ref.number} 的 review 發現 ${count}（GitHub 已標記 CHANGES_REQUESTED），因此未提供 approve。請修正後重新 \`:cr:\` review。`;
      }
    }
    return generic;
  }
}
