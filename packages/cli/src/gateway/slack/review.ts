/**
 * ReviewCoordinator — orchestrates a single `:cr:` reaction into an mra PR review.
 *
 * Flow per reaction:
 *   config.enabled gate → fetch reacted message text → parsePrRefs (cap) →
 *   emit review.triggered → for each PR (fail-soft):
 *     resolveProject → resolveRepoSlug → getPrHead →
 *     public/allowlist guard → claimReview →
 *     ensureReviewWorkspaceMeta + prepareReviewClone →
 *     getAuthUser == expectedGhUser →
 *     runMraReview → finalize + review.posted + thread status;
 *   on any pre-post failure: releaseReview + review.skipped + thread note;
 *   always: teardownReviewClone.
 */
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { WebClient } from "@slack/web-api";
import type { GatewayConfig } from "../config";
import { ReviewProgress } from "./review-progress";
import {
  gatewayConfigPath,
  loadRawGatewayConfig,
  resolveReviewConfig,
  resolveGithubToken,
  resolveReviewGhToken,
  reviewWorkspaceDir,
  isAdmin,
} from "../config";
import { appendGatewayEvent } from "../events";
import { parsePrRefs, type PrRef } from "../pr-ref";
import { claimReview, forceClaimReview, finalizeReview, releaseReview, type ReviewRef } from "../review-claim";
import {
  consumeApprovalReservation,
  listPendingApprovalReconciliations,
  markApprovalPendingReconcile,
  releaseApprovalReservation,
  reserveApprovalOffer,
  resolveApprovalReconciliation,
  saveApprovalOffer,
  type ApprovalOfferRef,
  type ApprovalReservation,
} from "../review-approval";
import {
  resolveProjectByRemote as resolveProjectByRemoteImpl,
  runMraReview as runMraReviewImpl,
  runMraAnalyze as runMraAnalyzeImpl,
} from "../../adapters/mra";
import { AUTOMATIC_APPROVAL_RELEASE_READY, effectiveMraReviewStrategy } from "../review-policy";
export { effectiveMraReviewStrategy } from "../review-policy";
import {
  resolveRepoSlug as resolveRepoSlugImpl,
  repoVisibility as repoVisibilityImpl,
  getAuthUser as getAuthUserImpl,
  getPrHead as getPrHeadImpl,
  approvalProtectionReady as approvalProtectionReadyImpl,
  createPullRequestApproval as createPullRequestApprovalImpl,
  hasPullRequestApproval as hasPullRequestApprovalImpl,
  createPullRequestReview as createPullRequestReviewImpl,
} from "../../adapters/github";
import {
  prepareReviewClone as prepareReviewCloneImpl,
  teardownReviewClone as teardownReviewCloneImpl,
  ensureReviewWorkspaceMeta as ensureReviewWorkspaceMetaImpl,
  pkbNeedsBuild as pkbNeedsBuildImpl,
} from "../review-workspace";

export interface ReviewGateway {
  resolveProjectByRemote: typeof resolveProjectByRemoteImpl;
  runMraReview: typeof runMraReviewImpl;
  runMraAnalyze: typeof runMraAnalyzeImpl;
  resolveRepoSlug: typeof resolveRepoSlugImpl;
  repoVisibility: typeof repoVisibilityImpl;
  getAuthUser: typeof getAuthUserImpl;
  getPrHead: typeof getPrHeadImpl;
  approvalProtectionReady: typeof approvalProtectionReadyImpl;
  createPullRequestApproval: typeof createPullRequestApprovalImpl;
  hasPullRequestApproval: typeof hasPullRequestApprovalImpl;
  createPullRequestReview: typeof createPullRequestReviewImpl;
  prepareReviewClone: typeof prepareReviewCloneImpl;
  teardownReviewClone: typeof teardownReviewCloneImpl;
  ensureReviewWorkspaceMeta: typeof ensureReviewWorkspaceMetaImpl;
  pkbNeedsBuild: typeof pkbNeedsBuildImpl;
}

export const realReviewGateway: ReviewGateway = {
  resolveProjectByRemote: resolveProjectByRemoteImpl,
  runMraReview: runMraReviewImpl,
  runMraAnalyze: runMraAnalyzeImpl,
  resolveRepoSlug: resolveRepoSlugImpl,
  repoVisibility: repoVisibilityImpl,
  getAuthUser: getAuthUserImpl,
  getPrHead: getPrHeadImpl,
  approvalProtectionReady: approvalProtectionReadyImpl,
  createPullRequestApproval: createPullRequestApprovalImpl,
  hasPullRequestApproval: hasPullRequestApprovalImpl,
  createPullRequestReview: createPullRequestReviewImpl,
  prepareReviewClone: prepareReviewCloneImpl,
  teardownReviewClone: teardownReviewCloneImpl,
  ensureReviewWorkspaceMeta: ensureReviewWorkspaceMetaImpl,
  pkbNeedsBuild: pkbNeedsBuildImpl,
};

/**
 * True when a message is an inline `:cr:` review request: it contains the
 * `:cr:` token AND at least one GitHub PR link. Requiring BOTH avoids
 * false-firing review on a stray PR link in ordinary chat. (option B-lite gate)
 */
export function isReviewRequest(text: string): boolean {
  return text.includes(":cr:") && parsePrRefs(text).length > 0;
}

/**
 * True when a message is an inline `:a:` approve request: it contains the `:a:`
 * token AND at least one GitHub PR link. `:a:` runs a fast single-agent review
 * then approves iff no high-severity issue is found.
 */
export function isApproveRequest(text: string): boolean {
  return text.includes(":a:") && parsePrRefs(text).length > 0;
}

/**
 * Bare confirmation inside a review thread. This is intentionally narrower than
 * ordinary chat: `:cr:` may offer approval, but GitHub APPROVE only happens after
 * an explicit user confirmation.
 */
export function isApproveConfirmationRequest(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[。.!！]+$/g, "")
    .replace(/\s+/g, " ");
  return [
    "approve",
    "approve pr",
    "approve this",
    "confirm approve",
    "yes approve",
    "確認 approve",
    "確認approve",
    "請 approve",
    "可以 approve",
    "進行 approve",
    "核准",
  ].includes(t);
}

/** Fields of an mra review result that shape the Slack result line. */
export interface ReviewOutcome {
  status?: string;
  commentCount?: number;
  blockerCount?: number;
  /** mra posted a neutral REVIEW_INCOMPLETE placeholder — the review never evaluated the PR. */
  incomplete?: boolean;
  protocolVersion?: "1.0";
  artifactSha256?: string;
  analyzedHeadSha?: string;
}

export function canConfirmApproveFromReview(res: ReviewOutcome): boolean {
  if (res.incomplete === true) return false;
  return res.protocolVersion === "1.0" && typeof res.artifactSha256 === "string" &&
    typeof res.analyzedHeadSha === "string" && res.blockerCount === 0 &&
    (res.status === "COMMENT" || res.status === "COMMENTED");
}

/** Result line for a plain `:cr:` review. It never claims GitHub approval. */
export function reviewResultText(slug: string, ref: PrRef, res: ReviewOutcome, approvalEnabled = true): string {
  if (res.incomplete)
    return `:warning: ${slug}#${ref.number} review 未完成（mra 回報 REVIEW_INCOMPLETE，未真正評估此 PR — 可能 max-turns 截斷或 provider 呼叫失敗）；已貼中性佔位，claim 已釋放，請重試 :cr:：${ref.url}`;
  const status = res.status ?? "COMMENT";
  const count = res.commentCount ?? 0;
  if (approvalEnabled && canConfirmApproveFromReview(res)) {
    return `:mag: 已完成 ${slug}#${ref.number} review（GitHub action: ${status}；${count} 則）。這個結果沒有 HIGH/CRITICAL blocker，可進一步 approve，但 :cr: 不會主動 approve；請由 PMK admin 在此 channel thread @PMK 回覆 \`approve\` 授權（DM 可直接回覆）：${ref.url}`;
  }
  return `:mag: 已完成 ${slug}#${ref.number} review（GitHub action: ${status}；${count} 則；未執行 GitHub approve）：${ref.url}`;
}

/**
 * Result line for a `:a:` approve. Incomplete first (a REVIEW_INCOMPLETE run posts a
 * neutral placeholder whose GitHub event reads COMMENT — without this branch it would
 * fall through to the misleading "請至 PR 確認是否已 approve"). Then three-way on the
 * mra status: the batch-fallback path (review.sh) posts individual comments and prints
 * NO `status:` line, so `status` is undefined there — we must NOT claim "發現重大問題 /
 * 未 approve" then, because GitHub may in fact have recorded an APPROVE. Point the user
 * to the PR instead of asserting a verdict we can't read.
 */
export function approveResultText(slug: string, ref: PrRef, res: ReviewOutcome): string {
  const cc = res.commentCount ?? 0;
  if (res.incomplete)
    return `:warning: 未 approve ${slug}#${ref.number} — review 未完成（mra 回報 REVIEW_INCOMPLETE，可能 max-turns 截斷或 provider 呼叫失敗），未做任何 approve；請重試 :a: 或手動 review：${ref.url}`;
  if (res.status === "APPROVED")
    return `:white_check_mark: 已 approve ${slug}#${ref.number}（無重大問題；${cc} 則 minor 建議）：${ref.url}`;
  if (res.status === "CHANGES_REQUESTED")
    return `:no_entry: 未 approve ${slug}#${ref.number} — 發現重大問題，已請求修改（${cc} 則）：${ref.url}`;
  return `:information_source: 已完成 ${slug}#${ref.number} review（GitHub 未回報 approve 狀態，${cc} 則；請至 PR 確認是否已 approve）：${ref.url}`;
}

/** Backoff before a single transient-failure retry of the mra review call. */
const MRA_RETRY_BACKOFF_MS = 4000;

/** Last non-empty line of `s`, with ANSI colour escapes stripped and trimmed. */
function lastNonEmptyLine(s?: string): string | undefined {
  if (!s) return undefined;
  const lines = s
    .split("\n")
    .map((l) => l.replace(/\[[0-9;]*m/g, "").trim())
    .filter(Boolean);
  return lines[lines.length - 1];
}

/**
 * Turn an mra failure into something actionable. Older mra review paths ran
 * providers under `set -euo pipefail` with `2>/dev/null`, so a non-zero provider
 * exit can become a silent `mra exited with code=1` with no stderr — `detail`
 * then falls back to the last stdout phase so the Slack message says WHERE it
 * died; `logDump` records the full picture for the operator's gateway log.
 */
export function describeMraFailure(res: {
  reason?: string;
  stderr?: string;
  stdout?: string;
}): { detail: string; logDump: string } {
  const errTail = lastNonEmptyLine(res.stderr);
  const outTail = lastNonEmptyLine(res.stdout);
  const detail = errTail
    ? errTail.slice(0, 200)
    : outTail
      ? `最後階段：${outTail.slice(0, 140)}`
      : "";
  const logDump = [
    `reason=${res.reason ?? "unknown"}`,
    errTail
      ? `stderr=${errTail}`
      : "stderr=(empty — mra likely swallowed the provider error via 2>/dev/null)",
    outTail ? `stdout(last)=${outTail}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
  return { detail, logDump };
}

/**
 * True when a message is a bare retry command (`retry` / `重試` / `重跑`), used
 * inside a review-result thread to re-run that thread's PR review. The bot
 * @-mention is stripped upstream, so we match the trimmed text exactly to avoid
 * intercepting ordinary chat that merely mentions "retry".
 */
export function isRetryRequest(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === "retry" || t === "重試";
}

export function isRerunRequest(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === "rerun" || t === "重跑";
}

export interface ReviewCoordinatorOptions {
  web: WebClient;
  config: GatewayConfig;
  onLog: (m: string) => void;
  gateway: ReviewGateway;
  /** Injectable sleep for the transient-failure retry backoff (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Production mode: stale startup review credentials must not survive a bad live reload. */
  strictLiveConfigReload?: boolean;
}

/** A review currently running detached — tracked so shutdown can drain it (A). */
interface InFlightReview {
  claimRef: ReviewRef;
  controller: AbortController;
  label: string;
  /** Where to post the "interrupted by restart" notice on shutdown (B). */
  channelId: string;
  threadTs: string;
  actorUserId: string;
  projectKey: string;
}

export class ReviewCoordinator {
  /** Reviews running right now (detached). Drained on shutdown (A). */
  private readonly inFlight = new Set<InFlightReview>();

  constructor(private readonly opts: ReviewCoordinatorOptions) {}

  private currentConfig(): GatewayConfig {
    try {
      // Tests and embedding callers may construct the coordinator without a
      // gateway.json. In the daemon, once the file exists, treat its review policy
      // as authoritative so deleting a token/approval flag/review block is a live
      // revocation rather than a stale merge with startup config.
      if (!fs.existsSync(gatewayConfigPath())) {
        if (!this.opts.strictLiveConfigReload) return this.opts.config;
        this.opts.onLog("review: live config missing; review disabled fail-closed");
        return { ...this.opts.config, github: undefined, review: undefined };
      }
      const loaded = loadRawGatewayConfig();
      return {
        ...this.opts.config,
        admins: loaded.admins,
        blocklist: loaded.blocklist,
        mraWorkspace: process.env.PMK_MRA_WORKSPACE ?? loaded.mraWorkspace,
        github: loaded.github,
        review: loaded.review,
      };
    } catch (err) {
      this.opts.onLog(`review: live config reload failed: ${(err as Error).message}`);
      if (!this.opts.strictLiveConfigReload) return this.opts.config;
      return { ...this.opts.config, github: undefined, review: undefined };
    }
  }

  /**
   * A (graceful drain): on gateway shutdown, abort every in-flight review —
   * SIGTERM its mra child so it doesn't run on as an orphan, and release its
   * claim so the PR is immediately re-reviewable (not falsely "already
   * reviewed"). Called from the shutdown handler BEFORE process.exit; releases
   * synchronously rather than waiting on each review's async finally (which the
   * exit would pre-empt). Returns the number drained.
   */
  drainOnShutdown(log: (msg: string) => void): number {
    const entries = [...this.inFlight];
    for (const e of entries) {
      try {
        e.controller.abort();
      } catch {
        /* best-effort */
      }
      releaseReview(e.claimRef);
      log(
        `review: interrupted ${e.label} by shutdown — mra killed, claim released (re-send to retry)`,
      );
      // B: tell the thread its review was cut short + how to re-run. Fire-and-forget
      // (void) — drainOnShutdown is sync; stop()'s 90s queue drain that follows gives
      // these posts time to land. reply() is best-effort (swallows its own errors).
      void this.reply(
        e.channelId,
        e.threadTs,
        ":warning: 這個 PR review 因服務重新啟動中斷，上線後在本 thread 回 `retry` 即可重跑。",
      );
    }
    this.inFlight.clear();
    return entries.length;
  }

  /** Wait before a single retry, unless the run was aborted (shutdown drain). */
  private async backoff(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const sleep = this.opts.sleep ?? ((m: number) => new Promise<void>((r) => setTimeout(r, m)));
    await sleep(ms);
  }

  private async reply(channel: string, threadTs: string, text: string): Promise<void> {
    try {
      await this.opts.web.chat.postMessage({ channel, thread_ts: threadTs, text });
    } catch (err) {
      this.opts.onLog(`review: reply failed: ${(err as Error).message}`);
    }
  }

  /** Like reply() but returns the posted message ts (for in-place progress edits). */
  private async replyWithTs(channel: string, threadTs: string, text: string): Promise<string | undefined> {
    try {
      const res = (await this.opts.web.chat.postMessage({ channel, thread_ts: threadTs, text })) as { ts?: string };
      return res.ts;
    } catch (err) {
      this.opts.onLog(`review: reply failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Whether the `:cr:` review flow is enabled (config-gated). */
  isEnabled(): boolean {
    return resolveReviewConfig(this.currentConfig().review).enabled;
  }

  /** `:cr:` REACTION on a message → fetch the message text, then review. */
  async fromReaction(args: {
    channelId: string;
    messageTs: string;
    reactorUserId: string;
  }): Promise<void> {
    const text = await this.fetchMessageText(args.channelId, args.messageTs);
    await this.processReviewRequest({
      channelId: args.channelId,
      threadTs: args.messageTs,
      actorUserId: args.reactorUserId,
      text: text ?? "",
    });
  }

  /**
   * Inline `:cr:` in a DM or @-mention message → review (option B-lite). The
   * message text is already in hand, so no conversations.history fetch. The
   * caller gates with `isEnabled()` + `isReviewRequest()` before routing here.
   */
  async fromMessage(args: {
    channelId: string;
    threadTs: string;
    userId: string;
    text: string;
  }): Promise<void> {
    await this.processReviewRequest({
      channelId: args.channelId,
      threadTs: args.threadTs,
      actorUserId: args.userId,
      text: args.text,
    });
  }

  /** `:a:` REACTION on a message → fetch the message text, then approve. */
  async fromApproveReaction(args: {
    channelId: string;
    messageTs: string;
    reactorUserId: string;
  }): Promise<void> {
    const text = await this.fetchMessageText(args.channelId, args.messageTs);
    await this.processApproveRequest({
      channelId: args.channelId,
      threadTs: args.messageTs,
      actorUserId: args.reactorUserId,
      text: text ?? "",
    });
  }

  /**
   * Inline `:a:` in a DM or @-mention message starts review plus approval
   * intent. A separate thread confirmation is still required. The caller gates with `isEnabled()` +
   * `isApproveRequest()` before routing here.
   */
  async fromApproveMessage(args: {
    channelId: string;
    threadTs: string;
    userId: string;
    text: string;
  }): Promise<void> {
    await this.processApproveRequest({
      channelId: args.channelId,
      threadTs: args.threadTs,
      actorUserId: args.userId,
      text: args.text,
    });
  }

  /** Shared core for `:a:` approve: parse PR refs, then approve each (fail-soft). */
  private async processApproveRequest(args: {
    channelId: string;
    threadTs: string;
    actorUserId: string;
    text: string;
    offeredRefs?: ApprovalOfferRef[];
    forced?: boolean;
  }): Promise<void> {
    const { channelId, threadTs, actorUserId, text } = args;
    const { gateway, onLog } = this.opts;
    const config = this.currentConfig();
    const review = resolveReviewConfig(config.review);
    if (!review.enabled) return;
    if (!review.approval.enabled) {
      await this.reply(channelId, threadTs, ":lock: GitHub automatic approval 目前為安全停用狀態；`:cr:` review 仍可正常使用。");
      return;
    }
    if (!isAdmin(config, actorUserId)) {
      await this.reply(channelId, threadTs, ":no_entry: GitHub approve 只能由 PMK admin 明確授權；`:cr:` review 仍可由一般使用者執行。");
      return;
    }
    if (!args.offeredRefs) {
      await this.reply(channelId, threadTs, ":mag: `:a:` 會先執行安全 review；完成且沒有 blocker 後，我會再請你於 thread 明確回覆 `approve`，不會直接核准。");
      await this.processReviewRequest({
        channelId,
        threadTs,
        actorUserId,
        text: text.replace(":a:", ":cr:"),
      });
      return;
    }

    const workspace = config.mraWorkspace;
    if (!workspace) {
      onLog("review: no mraWorkspace configured");
      return;
    }

    const refs = args.offeredRefs?.map(({ owner, repo, number, url }) => ({ owner, repo, number, url }))
      ?? parsePrRefs(text, { cap: review.maxPrsPerTrigger });
    if (refs.length === 0) return;

    appendGatewayEvent({
      type: "review.triggered",
      actor: actorUserId,
      channelId,
      prCount: refs.length,
      intent: "approve",
      providerMode: review.providerMode,
      strategy: effectiveMraReviewStrategy(review.strategy, review.providerMode, true),
      forced: args.forced,
    });

    // Multi-PR summary ack only. For a single PR the per-PR progress bar (posted
    // in runOne) IS the ack, so a separate "收到" message would just leave dead
    // clutter above the morphing progress message.
    if (refs.length > 1) {
      await this.reply(
        channelId,
        threadTs,
        `:lock: 收到，先快速 review ${refs.length} 個 PR 再決定是否 approve…（完成後逐一回報）`,
      );
    }

    const reviewWorkspaceRoot = reviewWorkspaceDir();
    const token = resolveReviewGhToken(config.review) ?? resolveGithubToken(config.github);

    for (const ref of refs) {
      const reviewWorkspace = path.join(reviewWorkspaceRoot, "runs", randomUUID());
      gateway.ensureReviewWorkspaceMeta(workspace, reviewWorkspace);
      try {
      await this.runOne(ref, {
        channelId,
        threadTs,
        reactorUserId: actorUserId,
        workspace,
        reviewWorkspace,
        review,
        token,
        authorizedHeads: args.offeredRefs
          ? new Map(args.offeredRefs.map((r) => [`${r.owner}/${r.repo}#${r.number}`, r.headSha]))
          : undefined,
        forceRerun: args.forced,
      }, "approve");
      } finally {
        try { fs.rmSync(reviewWorkspace, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }

  /**
   * `retry` posted in a review-result thread → re-run that thread's PR review.
   * Stateless: a Slack thread shares its root ts, so `threadTs` IS the original
   * `:cr:` trigger message — we re-fetch it and re-run. A prior FAILED review
   * released its claim, so the same commit re-reviews; a successful one's claim
   * is still finalized and falls through to the "already reviewed" note. If the
   * thread root isn't a review request (e.g. a bare top-level `retry`), nudge
   * the user instead of silently doing nothing.
   */
  async retryInThread(args: {
    channelId: string;
    threadTs: string;
    userId: string;
  }): Promise<void> {
    if (!resolveReviewConfig(this.currentConfig().review).enabled) return;
    const rootText = await this.fetchMessageText(args.channelId, args.threadTs);
    // An approve thread (`:a:`) is drained the same way as a `:cr:` review and its
    // interruption notice tells the user to reply `retry` — so retry must re-run
    // the APPROVE flow for an `:a:` root, not fall through to the nudge (which
    // would silently downgrade the approve intent). `:a:` wins over `:cr:` if both
    // tokens are present, matching the message-path ordering.
    const approve = rootText ? isApproveRequest(rootText) : false;
    const review = rootText ? isReviewRequest(rootText) : false;
    if (!rootText || (!approve && !review)) {
      await this.reply(
        args.channelId,
        args.threadTs,
        ":information_source: 這個 thread 沒有可重試的 PR review。請用 `:cr: <PR 連結>` 重新發起。",
      );
      return;
    }
    const req = {
      channelId: args.channelId,
      threadTs: args.threadTs,
      actorUserId: args.userId,
      text: rootText,
    };
    if (approve && !resolveReviewConfig(this.currentConfig().review).approval.enabled) {
      await this.reply(args.channelId, args.threadTs, ":lock: GitHub automatic approval 目前為安全停用狀態；請改用 `:cr:` 重跑 review。");
    } else if (approve) await this.processApproveRequest(req);
    else await this.processReviewRequest(req);
  }

  /** Admin-only forced re-review of an already finalized same-SHA claim. */
  async rerunInThread(args: { channelId: string; threadTs: string; userId: string }): Promise<void> {
    const config = this.currentConfig();
    if (!resolveReviewConfig(config.review).enabled) return;
    if (!isAdmin(config, args.userId)) {
      await this.reply(args.channelId, args.threadTs, ":no_entry: `rerun` 會略過同 commit 的完成紀錄，只允許 PMK admin 執行。");
      return;
    }
    const rootText = await this.fetchMessageText(args.channelId, args.threadTs);
    const approve = rootText ? isApproveRequest(rootText) : false;
    const review = rootText ? isReviewRequest(rootText) : false;
    if (!rootText || (!approve && !review)) {
      await this.reply(args.channelId, args.threadTs, ":information_source: 這個 thread 沒有可重跑的 PR review。");
      return;
    }
    const req = { channelId: args.channelId, threadTs: args.threadTs, actorUserId: args.userId, text: rootText, forced: true };
    if (approve) await this.processApproveRequest(req);
    else await this.processReviewRequest(req);
  }

  /**
   * `approve` posted in a `:cr:` review thread → explicit authorization to run
   * the approve path for the same PR. This keeps `:cr:` review-only while giving
   * users a clear one-step confirmation when the review result is approvable.
   */
  async confirmApproveInThread(args: {
    channelId: string;
    threadTs: string;
    userId: string;
  }): Promise<void> {
    const config = this.currentConfig();
    const review = resolveReviewConfig(config.review);
    if (!review.enabled) return;
    if (!AUTOMATIC_APPROVAL_RELEASE_READY || !review.approval.enabled) {
      await this.reply(args.channelId, args.threadTs, ":lock: GitHub automatic approval 目前為安全停用狀態；這個 review 不會執行 approve。");
      return;
    }
    if (!isAdmin(config, args.userId)) {
      await this.reply(args.channelId, args.threadTs, ":no_entry: approve 授權只接受 PMK admin；請 admin 在此 thread 回覆 `approve`。");
      return;
    }
    const pending = listPendingApprovalReconciliations(args.channelId, args.threadTs);
    if (pending.length > 0) {
      const token = resolveReviewGhToken(config.review) ?? resolveGithubToken(config.github);
      const actor = review.expectedGhUser ?? await this.opts.gateway.getAuthUser({ token });
      if (!actor) {
        await this.reply(args.channelId, args.threadTs, ":warning: pending approve 無法確認 GitHub identity，未自動重送。");
        return;
      }
      for (const item of pending) {
        const matches = await Promise.all(item.refs.map((ref) => this.opts.gateway.hasPullRequestApproval({
          slug: `${ref.owner}/${ref.repo}`, pr: ref.number, commitId: ref.headSha,
          artifactSha256: ref.artifactSha256, actor, token,
        })));
        if (matches.every((v) => v === true)) {
          resolveApprovalReconciliation(item, "consumed");
          await this.reply(args.channelId, args.threadTs, ":information_source: 已由 GitHub review ledger 確認先前 approve 成功，不會重送。");
          return;
        }
        // A negative list result is not proof that a timed-out POST will never
        // become visible. Keep pending until an operator explicitly resolves it.
        if (matches.every((v) => v === false)) {
          await this.reply(args.channelId, args.threadTs, ":warning: GitHub 尚未找到先前 approve，但為避免 eventual-consistency 重複送出，維持 pending reconcile，需由 operator 處理。");
          return;
        }
        await this.reply(args.channelId, args.threadTs, ":warning: pending approve 對帳結果不完整，維持 pending reconcile，不會自動重送。");
        return;
      }
    }
    const reservation = reserveApprovalOffer(args.channelId, args.threadTs);
    if (!reservation?.refs.length) {
      await this.reply(
        args.channelId,
        args.threadTs,
        ":information_source: 這個 thread 沒有有效、未使用的 approve offer。請先完成 `:cr: <PR 連結>` review；offer 使用一次或逾時後需重新 review。",
      );
      return;
    }
    await this.publishApprovalReservation(reservation, args.userId);
  }

  private async publishApprovalReservation(reservation: ApprovalReservation, actorUserId: string): Promise<void> {
    const { gateway } = this.opts;
    let mutationStarted = false;
    try {
      if (reservation.refs.length !== 1)
        throw new Error("multi-PR approval must be confirmed in separate review threads");
      for (const ref of reservation.refs) {
        const live = this.currentConfig();
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
        const before = await gateway.getPrHead({ slug, pr: ref.number, token });
        if (!before || before.sha !== ref.headSha || before.baseRef !== ref.baseRef ||
            (ref.contextVersion && before.updatedAt !== ref.contextVersion))
          throw new Error("PR head, base, or review context changed after review");
        if (!await gateway.approvalProtectionReady({ slug, branch: ref.baseRef, token }))
          throw new Error("repository protection is not approval-ready");
        const finalLive = this.currentConfig();
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
        if (finalActor !== authUser || !finalHead || finalHead.sha !== ref.headSha || finalHead.baseRef !== ref.baseRef ||
            (ref.contextVersion && finalHead.updatedAt !== ref.contextVersion))
          throw new Error("approval identity or PR changed during final preflight");
        const postFence = this.currentConfig();
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
        await this.reply(reservation.channelId, reservation.threadTs,
          `:white_check_mark: 已真實 approve ${slug}#${ref.number}（commit \`${ref.headSha.slice(0, 7)}\`，GitHub review #${posted.reviewId}）。`);
      }
      consumeApprovalReservation(reservation);
    } catch (err) {
      if (mutationStarted) {
        markApprovalPendingReconcile(reservation);
        await this.reply(reservation.channelId, reservation.threadTs,
          `:warning: approve 結果無法確定，已進入 pending reconcile，不會自動重送：${(err as Error).message}`);
      } else {
        releaseApprovalReservation(reservation);
        await this.reply(reservation.channelId, reservation.threadTs,
          `:no_entry: approve preflight 未通過，授權尚未消耗：${(err as Error).message}`);
      }
    }
  }

  /** Shared core: parse PR refs from the text, then review each (fail-soft). */
  private async processReviewRequest(args: {
    channelId: string;
    threadTs: string;
    actorUserId: string;
    text: string;
    forced?: boolean;
  }): Promise<void> {
    const { channelId, threadTs, actorUserId, text } = args;
    const { gateway, onLog } = this.opts;
    const config = this.currentConfig();
    const review = resolveReviewConfig(config.review);
    if (!review.enabled) return;

    const workspace = config.mraWorkspace;
    if (!workspace) {
      onLog("review: no mraWorkspace configured");
      return;
    }

    const refs = parsePrRefs(text, { cap: review.maxPrsPerTrigger });
    if (refs.length === 0) return;

    appendGatewayEvent({
      type: "review.triggered",
      actor: actorUserId,
      channelId,
      prCount: refs.length,
      intent: "review",
      providerMode: review.providerMode,
      strategy: effectiveMraReviewStrategy(review.strategy, review.providerMode, false),
      forced: args.forced,
    });

    // Multi-PR summary ack only — a single PR's own progress bar (runOne) is its
    // ack. The review runs detached (minutes); for N>1 PRs this one message tells
    // the user all N were received before the per-PR bars start arriving.
    if (refs.length > 1) {
      await this.reply(
        channelId,
        threadTs,
        `:mag: 收到，背景 review ${refs.length} 個 PR…（完成後逐一回報；你可以繼續聊或再發）`,
      );
    }

    const reviewWorkspaceRoot = reviewWorkspaceDir(); // ~/.pmk/review-workspace
    // Pinned review token (stable identity, independent of the host's active
    // gh account) takes priority; fall back to the issue-flow github token, else
    // undefined → host ambient gh. Used only by PMK-owned GitHub calls.
    const token = resolveReviewGhToken(config.review) ?? resolveGithubToken(config.github);

    for (const ref of refs) {
      const reviewWorkspace = path.join(reviewWorkspaceRoot, "runs", randomUUID());
      gateway.ensureReviewWorkspaceMeta(workspace, reviewWorkspace);
      try {
        await this.runOne(ref, {
          channelId,
          threadTs,
          reactorUserId: actorUserId,
          workspace,
          reviewWorkspace,
          review,
          token,
          forceRerun: args.forced,
        }, "review");
      } finally {
        try { fs.rmSync(reviewWorkspace, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }

  /**
   * Shared per-PR pipeline for BOTH `:cr:` review and `:a:` approve. `mode`
   * selects the only points that differ: the message verb, the progress-bar
   * pacing (approve always runs the fast `standard` pass), the mra approve flags,
   * and the result line. Everything else — project/slug/head resolution,
   * public/allowlist guard, idempotent claim, in-flight registration for the
   * shutdown drain, one-time PKB build, isolated clone prep, gh-actor identity
   * verify, teardown — is identical, so a fix here lands on both paths at once
   * (the reason not to keep two near-verbatim copies).
   */
  private async runOne(
    ref: PrRef,
    ctx: {
      channelId: string;
      threadTs: string;
      reactorUserId: string;
      workspace: string;
      reviewWorkspace: string;
      review: ReturnType<typeof resolveReviewConfig>;
      token?: string;
      authorizedHeads?: Map<string, string>;
      forceRerun?: boolean;
    },
    mode: "review" | "approve",
  ): Promise<void> {
    const { gateway, onLog } = this.opts;
    const isApprove = mode === "approve";
    const verb = isApprove ? "approve" : "review";
    // approve always runs the fast single-agent pass. :cr: must run the
    // configured review strategy for the selected provider; mra is responsible
    // for rejecting unsupported provider+strategy pairs explicitly.
    // The progress-bar pacing MUST match the strategy actually run.
    const strategy = effectiveMraReviewStrategy(ctx.review.strategy, ctx.review.providerMode, isApprove);
    const slugDisplay = `${ref.owner}/${ref.repo}`;

    let progress: ReviewProgress | undefined = undefined;

    const skip = async (reason: string, msg: string): Promise<void> => {
      appendGatewayEvent({
        type: "review.skipped",
        actor: ctx.reactorUserId,
        repo: slugDisplay,
        pr: ref.number,
        reason,
      });
      if (progress) await progress.finish(msg);
      else await this.reply(ctx.channelId, ctx.threadTs, msg);
    };

    const project = gateway.resolveProjectByRemote(ctx.workspace, slugDisplay);
    if (!project) {
      await skip(
        "not-in-workspace",
        `:information_source: \`${slugDisplay}\` 不在 mra workspace，略過 PR #${ref.number}`,
      );
      return;
    }

    const slug = await gateway.resolveRepoSlug(ctx.workspace, project);
    if (!slug) {
      await skip(
        "slug",
        `:warning: 無法從 \`${project}\` 推出 GitHub slug，略過 PR #${ref.number}`,
      );
      return;
    }

    const head = await gateway.getPrHead({ slug, pr: ref.number, token: ctx.token });
    if (!head) {
      await skip("pr-head", `:warning: 取不到 PR #${ref.number} 的 head，略過`);
      return;
    }
    const authorizedHead = ctx.authorizedHeads?.get(`${ref.owner}/${ref.repo}#${ref.number}`);
    if (authorizedHead && authorizedHead !== head.sha) {
      await skip("approval-head-changed", `:warning: PR #${ref.number} 在 approve 授權後已有新 commit；未 approve，請重新執行 :cr:。`);
      return;
    }

    // public-repo / allowlist guard (checked BEFORE claim to avoid wasted claims)
    if (ctx.review.repoAllowlist && !ctx.review.repoAllowlist.includes(slug)) {
      await skip(
        "allowlist",
        `:no_entry: \`${slug}\` 不在 review allowlist，略過 PR #${ref.number}`,
      );
      return;
    }
    if (!ctx.review.allowPublicRepos) {
      const vis = await gateway.repoVisibility({ slug, token: ctx.token });
      if (vis !== "private") {
        await skip(
          "public-repo",
          `:no_entry: \`${slug}\` 為 public（或無法判定），略過 PR #${ref.number} 以免外洩`,
        );
        return;
      }
    }

    const slugParts = slug.split("/");
    const [slugOwner, slugRepo] =
      slugParts.length === 2
        ? slugParts
        : [ref.owner, ref.repo];
    const claimRef = {
      owner: slugOwner,
      repo: slugRepo,
      pr: ref.number,
      headSha: head.sha,
      intent: isApprove ? "approve" as const : "review" as const,
      contextVersion: head.updatedAt,
    };
    const projectKey = `${slugOwner}/${slugRepo}`;
    const actorActive = [...this.inFlight].filter((r) => r.actorUserId === ctx.reactorUserId).length;
    if (this.inFlight.size >= ctx.review.maxConcurrent || actorActive >= ctx.review.maxConcurrentPerUser || [...this.inFlight].some((r) => r.projectKey === projectKey)) {
      await skip("busy", `:hourglass: review 目前已達併發上限，或同一 repo 正在 review；請稍後重試。`);
      return;
    }
    const claimed = ctx.forceRerun ? forceClaimReview(claimRef) : claimReview(claimRef);
    if (!claimed) {
      // Idempotency: this exact commit was already reviewed. Don't re-review
      // (avoids duplicate posts) — but DON'T be silent: the user got the "收到"
      // ack, so tell them why no result follows. (Benign; no review.skipped
      // event so it doesn't read as a failure.)
      onLog(`review: already done ${slug}#${ref.number}@${head.sha.slice(0, 8)}`);
      const alreadyDone = isApprove
        ? `:information_source: ${slug}#${ref.number} 這個 commit（\`${head.sha.slice(0, 7)}\`）已經執行過 approve check，略過（同一 commit 不重複 approve）。要重新判斷請推新 commit 後再發 :a:。`
        : `:information_source: ${slug}#${ref.number} 這個 commit（\`${head.sha.slice(0, 7)}\`）已經 review 過了，略過（同一 commit 不重複審）。要重審請推新 commit 後再發。`;
      await this.reply(
        ctx.channelId,
        ctx.threadTs,
        alreadyDone,
      );
      return;
    }

    // A: register this review so a shutdown can abort it (SIGTERM the mra
    // child) and release its claim, instead of orphaning it.
    const controller = new AbortController();
    const inflight: InFlightReview = {
      claimRef,
      controller,
      label: `${slug}#${ref.number}`,
      channelId: ctx.channelId,
      threadTs: ctx.threadTs,
      actorUserId: ctx.reactorUserId,
      projectKey,
    };
    this.inFlight.add(inflight);

    const headline = `:mag: ${verb} ${slug}#${ref.number}`;
    const progressTs = await this.replyWithTs(
      ctx.channelId, ctx.threadTs,
      `${headline}\n▱▱▱▱▱ 5%\n目前:準備工作區`,
    );
    progress = progressTs
      ? new ReviewProgress({
          web: this.opts.web, channel: ctx.channelId, ts: progressTs,
          strategy, headline, onLog: this.opts.onLog,
        })
      : undefined;

    let posted = false;
    try {
      // Ensure a fresh PKB on the main clone BEFORE prepareReviewClone copies it
      // into the review checkout. Without a PKB the review agents grep the whole
      // codebase, hit --max-turns, and the review comes back REVIEW_INCOMPLETE.
      // Best-effort: if the build fails we still review (the max-turns safety net
      // + the honest verdict cover it). One-time ~few-min cost the first time a
      // repo is reviewed (or after it goes stale).
      const mainClone = `${ctx.workspace}/${project}`;
      if (ctx.review.providerMode === "claude" && gateway.pkbNeedsBuild(mainClone)) {
        onLog(`pkb: ${project} 缺/過時 PKB — 先建(一次性,之後 review 又快又完整)`);
        const built = await gateway.runMraAnalyze(
          { project, cwd: ctx.workspace, signal: controller.signal },
          { onProgress: (line) => onLog(`mra analyze ${project}: ${line}`) },
        );
        if (!built.ok) {
          onLog(`pkb: build 未完成(${built.reason ?? "unknown"})— 仍繼續 review`);
        }
      }

      const prep = await gateway.prepareReviewClone({
        mainClone,
        reviewWorkspace: ctx.reviewWorkspace,
        project,
        slug,
        pr: ref.number,
        expectedHeadSha: head.sha,
        baseRef: head.baseRef,
        ghToken: ctx.token, // pin git clone/fetch auth (stable vs active gh)
      });
      if (!prep.ok) {
        await skip(
          "prepare-failed",
          `:warning: PR #${ref.number} 準備失敗（${prep.reason}），略過`,
        );
        return;
      }

      // Verify the identity mra will POST under. With a pinned review token,
      // mra posts as THAT token (reviewEnv sets GH_TOKEN), so we verify the
      // token's identity. Without a pin, ctx.token is undefined → getAuthUser
      // checks the HOST AMBIENT gh identity (what mra falls back to). Either
      // way this checks "who the review will be posted as".
      const actor = await gateway.getAuthUser({ token: ctx.token });
      if (ctx.review.expectedGhUser && actor !== ctx.review.expectedGhUser) {
        await skip(
          "gh-actor",
          `:no_entry: gh 身分為 \`${actor ?? "unknown"}\`，非預期帳號，未貼 review（避免身分混淆）`,
        );
        return;
      }

      const t0 = Date.now();
      const mraArgs = {
        workspace: ctx.reviewWorkspace,
        project,
        pr: ref.number,
        strategy,
        cwd: ctx.reviewWorkspace,
        providerMode: ctx.review.providerMode,
        expectedHeadSha: head.sha,
        baseRef: prep.baseRef,
        baseSha: head.baseSha,
        prContext: { title: head.title, body: head.body, updatedAt: head.updatedAt },
        signal: controller.signal, // A: shutdown aborts → SIGTERM the review child
      };
      const onProgress = (line: string) => {
        onLog(`mra ${verb} ${slug}#${ref.number}: ${line}`);
        progress?.onLine(line);
      };
      let res = await gateway.runMraReview(mraArgs, { onProgress });
      let retried = false;
      // Retry once on a transient failure OR a REVIEW_INCOMPLETE. Provider
      // overload/rate-limit can surface as a bare `exited with code=1`
      // (res.ok=false), while an empty / unparseable response makes mra EXIT 0
      // but post a neutral REVIEW_INCOMPLETE placeholder. Both routinely recover
      // on a re-run. Skip the retry if aborted (shutdown drain) — not transient,
      // clone about to be torn down.
      if ((!res.ok || res.incomplete) && !controller.signal.aborted) {
        const why = res.ok
          ? "回報 REVIEW_INCOMPLETE"
          : `失敗 — ${describeMraFailure(res).logDump}`;
        onLog(
          `mra ${verb} ${slug}#${ref.number} 第一次${why}，${MRA_RETRY_BACKOFF_MS / 1000}s 後重試一次`,
        );
        await this.backoff(MRA_RETRY_BACKOFF_MS, controller.signal);
        if (!controller.signal.aborted) {
          retried = true;
          res = await gateway.runMraReview(mraArgs, { onProgress });
        }
      }
      if (!res.ok) {
        const { detail, logDump } = describeMraFailure(res);
        onLog(`mra ${verb} ${slug}#${ref.number} FAILED${retried ? " (after retry)" : ""}: ${logDump}`);
        await skip(
          "mra-failed",
          `:warning: PR #${ref.number} ${verb} 失敗${retried ? "（已重試）" : ""}：${res.reason ?? "unknown"}${detail ? `\n> ${detail}` : ""}`,
        );
        return;
      }
      if (res.incomplete) {
        // Still REVIEW_INCOMPLETE after the retry: mra only posted a neutral
        // placeholder, so the PR was never actually evaluated. Do NOT finalize the
        // per-commit claim (that would reject a same-commit re-:a: as "already
        // reviewed" and make the "請重試" advice a dead end) — route through skip so
        // the finally releases the claim, and report honestly instead of the
        // misleading ambiguous-approve line.
        onLog(`mra ${verb} ${slug}#${ref.number} REVIEW_INCOMPLETE${retried ? "（重試後仍）" : ""} — 釋放 claim 供重試`);
        await skip(
          "review-incomplete",
          isApprove ? approveResultText(slug, ref, res) : reviewResultText(slug, ref, res),
        );
        return;
      }

      if (res.protocolVersion === "1.0") {
        const live = this.currentConfig();
        const liveReview = resolveReviewConfig(live.review);
        if (!liveReview.enabled || live.blocklist.includes(ctx.reactorUserId)) {
          await skip("policy-revoked", ":no_entry: review policy 在分析期間已撤銷，未貼 GitHub review。");
          return;
        }
        if (liveReview.repoAllowlist && !liveReview.repoAllowlist.includes(slug)) {
          await skip("policy-revoked", ":no_entry: repository 已不在 review allowlist，未貼 GitHub review。");
          return;
        }
        const liveToken = resolveReviewGhToken(live.review) ?? resolveGithubToken(live.github);
        const liveActor = await gateway.getAuthUser({ token: liveToken });
        if (!liveActor || (liveReview.expectedGhUser && liveActor !== liveReview.expectedGhUser)) {
          await skip("gh-actor-revoked", ":no_entry: GitHub review identity 在分析期間已改變，未貼 review。");
          return;
        }
        const liveHead = await gateway.getPrHead({ slug, pr: ref.number, token: liveToken });
        if (!liveHead || liveHead.sha !== head.sha) {
          await skip("review-head-changed", `:warning: PR #${ref.number} 在分析期間已有新 commit；未貼過期 review。`);
          return;
        }
        const postedReview = await gateway.createPullRequestReview({
          slug,
          pr: ref.number,
          commitId: head.sha,
          token: liveToken,
          event: res.status === "CHANGES_REQUESTED" ? "REQUEST_CHANGES" : "COMMENT",
          body: `${res.summary ?? "MRA review completed"}\n\nMRA artifact: ${res.artifactSha256}`,
          comments: res.findings ?? [],
        });
        res.status = postedReview.state;
      }

      posted = true;
      finalizeReview(claimRef, { status: res.status });
      if (!isApprove && ctx.review.approval.enabled && canConfirmApproveFromReview(res)) {
        saveApprovalOffer(ctx.channelId, ctx.threadTs, {
          owner: slugOwner,
          repo: slugRepo,
          number: ref.number,
          url: ref.url,
          headSha: head.sha,
          baseRef: head.baseRef,
          artifactSha256: res.artifactSha256!,
          contextVersion: head.updatedAt,
        });
      }
      appendGatewayEvent({
        type: "review.posted",
        actor: ctx.reactorUserId,
        repo: slug,
        pr: ref.number,
        status: res.status ?? "COMMENT",
        commentCount: res.commentCount ?? 0,
        blockerCount: res.blockerCount,
        intent: mode,
        providerMode: ctx.review.providerMode,
        strategy,
        headSha: head.sha,
        forced: ctx.forceRerun,
        durationMs: Date.now() - t0,
      });
      const resultText = isApprove
        ? approveResultText(slug, ref, res)
        : reviewResultText(slug, ref, res, ctx.review.approval.enabled);
      if (progress) await progress.finish(resultText);
      else await this.reply(ctx.channelId, ctx.threadTs, resultText);
    } catch (err) {
      await skip(
        "error",
        `:warning: PR #${ref.number} ${verb} 例外：${(err as Error).message}`,
      );
    } finally {
      progress?.dispose();
      this.inFlight.delete(inflight);
      if (!posted) releaseReview(claimRef);
      gateway.teardownReviewClone({ reviewWorkspace: ctx.reviewWorkspace, project });
    }
  }

  private async fetchMessageText(
    channel: string,
    ts: string,
  ): Promise<string | undefined> {
    try {
      const res = (await this.opts.web.conversations.history({
        channel,
        latest: ts,
        oldest: ts,
        inclusive: true,
        limit: 1,
      } as never)) as { messages?: Array<{ text?: string }> };
      return res.messages?.[0]?.text;
    } catch (err) {
      this.opts.onLog(`review: fetch message failed: ${(err as Error).message}`);
      return undefined;
    }
  }
}
