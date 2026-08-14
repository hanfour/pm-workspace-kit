/**
 * ReviewCoordinator — parses `:cr:` reactions and gates them for admission.
 *
 * Flow per reaction:
 *   config.enabled gate → fetch reacted message text → parsePrRefs (cap) →
 *   emit review.triggered → dispatch to runner via this.runner.runOne(…).
 *
 * The executor pipeline (claim → workspace → analysis → post → finalize) is now
 * in ReviewRunner. See review-runner.ts for the per-PR execution flow.
 *
 * Also: on approval-confirmation reactions, routes to the approve-offer flow.
 */
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { WebClient } from "@slack/web-api";
import type { GatewayConfig } from "../config";
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
import { parsePrRefs } from "../pr-ref";
import { type ApprovalOfferRef } from "../review-approval";
import {
  resolveProjectByRemote as resolveProjectByRemoteImpl,
  runMraReview as runMraReviewImpl,
  runMraAnalyze as runMraAnalyzeImpl,
} from "../../adapters/mra";
import { effectiveMraReviewStrategy } from "../review-policy";
export { effectiveMraReviewStrategy } from "../review-policy";
// protectionNotReadyMessage moved to the leaf review-policy module so
// review-approve-flow can import it without a runtime cycle back through here.
// Re-exported so existing importers keep working unchanged.
export { protectionNotReadyMessage } from "../review-policy";
import {
  resolveRepoSlug as resolveRepoSlugImpl,
  repoVisibility as repoVisibilityImpl,
  getAuthUser as getAuthUserImpl,
  getPrHead as getPrHeadImpl,
  listPrDiscussion as listPrDiscussionImpl,
  approvalProtectionReady as approvalProtectionReadyImpl,
  reviewGateStatus as reviewGateStatusImpl,
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
import { ApproveFlow } from "./review-approve-flow";
import { ReviewRunner } from "./review-runner";
// Pure request classifiers + result-text formatters live in sibling modules.
// Imported for internal use, and re-exported so slack/index.ts and the review
// tests keep importing them from "./review" unchanged.
import { isReviewRequest, isApproveRequest, rerunPrRefs } from "./review-requests";
import { threadReadFailedMessage } from "./review-messages";
export {
  isReviewRequest,
  isApproveRequest,
  isApproveConfirmationRequest,
  isReviewCommandMissingPr,
  reviewCommandUsageText,
  isRetryRequest,
  isRerunRequest,
  rerunPrRefs,
} from "./review-requests";
export {
  type ReviewOutcome,
  canConfirmApproveFromReview,
  reviewResultText,
  approveResultText,
  describeMraFailure,
  threadReadFailedMessage,
} from "./review-messages";

/**
 * Outcome of reading one Slack message. `ok: true` with an undefined `text`
 * means the read succeeded and the message carries no text; `ok: false` means
 * the read itself failed and NOTHING is known about the message.
 */
export type MessageTextRead =
  | { readonly ok: true; readonly text: string | undefined }
  | { readonly ok: false; readonly error: string };

export interface ReviewGateway {
  resolveProjectByRemote: typeof resolveProjectByRemoteImpl;
  runMraReview: typeof runMraReviewImpl;
  runMraAnalyze: typeof runMraAnalyzeImpl;
  resolveRepoSlug: typeof resolveRepoSlugImpl;
  repoVisibility: typeof repoVisibilityImpl;
  getAuthUser: typeof getAuthUserImpl;
  getPrHead: typeof getPrHeadImpl;
  listPrDiscussion: typeof listPrDiscussionImpl;
  approvalProtectionReady: typeof approvalProtectionReadyImpl;
  reviewGateStatus: typeof reviewGateStatusImpl;
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
  listPrDiscussion: listPrDiscussionImpl,
  approvalProtectionReady: approvalProtectionReadyImpl,
  reviewGateStatus: reviewGateStatusImpl,
  createPullRequestApproval: createPullRequestApprovalImpl,
  hasPullRequestApproval: hasPullRequestApprovalImpl,
  createPullRequestReview: createPullRequestReviewImpl,
  prepareReviewClone: prepareReviewCloneImpl,
  teardownReviewClone: teardownReviewCloneImpl,
  ensureReviewWorkspaceMeta: ensureReviewWorkspaceMetaImpl,
  pkbNeedsBuild: pkbNeedsBuildImpl,
};

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

export class ReviewCoordinator {
  private readonly approveFlow: ApproveFlow;
  private readonly runner: ReviewRunner;

  constructor(private readonly opts: ReviewCoordinatorOptions) {
    this.approveFlow = new ApproveFlow({
      gateway: this.opts.gateway,
      currentConfig: () => this.currentConfig(),
      fetchMessageText: (ch, ts) => this.fetchMessageText(ch, ts),
      reply: (ch, ts, text) => this.reply(ch, ts, text),
    });
    this.runner = new ReviewRunner({
      gateway: this.opts.gateway,
      web: this.opts.web,
      onLog: this.opts.onLog,
      sleep: this.opts.sleep,
      currentConfig: () => this.currentConfig(),
      reply: (ch, ts, text) => this.reply(ch, ts, text),
    });
  }

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
   * reviewed"). Called from the shutdown handler BEFORE process.exit. Implemented
   * in ReviewRunner; kept here so the coordinator's public surface (and
   * slack/index.ts) is unchanged.
   */
  drainOnShutdown(log: (msg: string) => void): number {
    return this.runner.drainOnShutdown(log);
  }

  private async reply(channel: string, threadTs: string, text: string): Promise<void> {
    try {
      await this.opts.web.chat.postMessage({ channel, thread_ts: threadTs, text });
    } catch (err) {
      this.opts.onLog(`review: reply failed: ${(err as Error).message}`);
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
    const read = await this.readMessageText(args.channelId, args.messageTs);
    if (!read.ok) {
      // Without the text there are no PR refs, and processReviewRequest returns
      // early on zero refs — so this used to be a completely silent drop.
      await this.reply(
        args.channelId,
        args.messageTs,
        threadReadFailedMessage({ error: read.error, command: "cr" }),
      );
      return;
    }
    await this.processReviewRequest({
      channelId: args.channelId,
      threadTs: args.messageTs,
      actorUserId: args.reactorUserId,
      text: read.text ?? "",
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
    const read = await this.readMessageText(args.channelId, args.messageTs);
    if (!read.ok) {
      await this.reply(
        args.channelId,
        args.messageTs,
        threadReadFailedMessage({ error: read.error, command: "a" }),
      );
      return;
    }
    await this.processApproveRequest({
      channelId: args.channelId,
      threadTs: args.messageTs,
      actorUserId: args.reactorUserId,
      text: read.text ?? "",
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
      // Record the APPROVE intent before delegating. The delegated run audits
      // itself as a review (that is what runs), so without this line an
      // `:a:`-initiated run is indistinguishable from a plain `:cr:` after
      // the fact — the audit could not answer "who asked to approve what".
      appendGatewayEvent({
        type: "review.triggered",
        actor: actorUserId,
        channelId,
        prCount: parsePrRefs(text, { cap: review.maxPrsPerTrigger }).length,
        intent: "approve",
        providerMode: review.providerMode,
        strategy: effectiveMraReviewStrategy(review.strategy, review.providerMode, true),
        forced: args.forced,
      });
      await this.processReviewRequest({
        channelId,
        threadTs,
        actorUserId,
        text: text.replace(":a:", ":cr:"),
        origin: "a",
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
    // in the runner's runOne) IS the ack, so a separate "收到" message would just leave dead
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
      await this.runner.runOne(ref, {
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
    const read = await this.readMessageText(args.channelId, args.threadTs);
    if (!read.ok) {
      await this.reply(
        args.channelId,
        args.threadTs,
        threadReadFailedMessage({ error: read.error, command: "retry" }),
      );
      return;
    }
    const rootText = read.text;
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

  /**
   * Admin-only forced re-review of an already finalized same-SHA claim.
   *
   * `rerun <PR 連結>` names its own target and skips the thread-root read
   * entirely, so it works in a channel the bot cannot read back. A bare `rerun`
   * still resolves the PR from the thread root.
   */
  async rerunInThread(args: {
    channelId: string;
    threadTs: string;
    userId: string;
    /** The rerun message itself; a PR link in it takes precedence over the root. */
    text?: string;
  }): Promise<void> {
    const config = this.currentConfig();
    if (!resolveReviewConfig(config.review).enabled) return;
    if (!isAdmin(config, args.userId)) {
      await this.reply(args.channelId, args.threadTs, ":no_entry: `rerun` 會略過同 commit 的完成紀錄，只允許 PMK admin 執行。");
      return;
    }
    if (args.text && rerunPrRefs(args.text).length > 0) {
      await this.processReviewRequest({
        channelId: args.channelId,
        threadTs: args.threadTs,
        actorUserId: args.userId,
        text: args.text,
        forced: true,
      });
      return;
    }
    const read = await this.readMessageText(args.channelId, args.threadTs);
    if (!read.ok) {
      await this.reply(
        args.channelId,
        args.threadTs,
        threadReadFailedMessage({ error: read.error, command: "rerun" }),
      );
      return;
    }
    const rootText = read.text;
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
   * the approve path for the same PR. Implemented in ApproveFlow; kept here so
   * the coordinator's public surface (and slack/index.ts) is unchanged.
   */
  async confirmApproveInThread(args: {
    channelId: string;
    threadTs: string;
    userId: string;
    text?: string;
  }): Promise<void> {
    return this.approveFlow.confirmInThread(args);
  }

  /** Shared core: parse PR refs from the text, then review each (fail-soft). */
  private async processReviewRequest(args: {
    /** Which command the user typed. `:a:` delegates here for its pre-review. */
    origin?: "cr" | "a";
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

    // Multi-PR summary ack only — a single PR's own progress bar (the runner's runOne) is its
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
        await this.runner.runOne(ref, {
          channelId,
          threadTs,
          reactorUserId: actorUserId,
          workspace,
          reviewWorkspace,
          review,
          token,
          forceRerun: args.forced,
          origin: args.origin,
        }, "review");
      } finally {
        try { fs.rmSync(reviewWorkspace, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }

  /**
   * Read one message's text. The result distinguishes "read it, here is the
   * text" from "could not read it" — collapsing both into `undefined` is what
   * let a missing `channels:history` scope surface to users as "this thread has
   * no PR review" (2026-08-14, finance-system#378). Callers that speak to the
   * user MUST branch on `ok` rather than on the text being empty.
   */
  private async readMessageText(channel: string, ts: string): Promise<MessageTextRead> {
    try {
      const res = (await this.opts.web.conversations.history({
        channel,
        latest: ts,
        oldest: ts,
        inclusive: true,
        limit: 1,
      } as never)) as { messages?: Array<{ text?: string }> };
      return { ok: true, text: res.messages?.[0]?.text };
    } catch (err) {
      const error = (err as Error).message;
      this.opts.onLog(`review: fetch message failed: ${error}`);
      return { ok: false, error };
    }
  }

  /**
   * Text-or-undefined view of {@link readMessageText}, for callers whose
   * behaviour on a read failure is already the same as on a missing message.
   */
  private async fetchMessageText(channel: string, ts: string): Promise<string | undefined> {
    const read = await this.readMessageText(channel, ts);
    return read.ok ? read.text : undefined;
  }
}
