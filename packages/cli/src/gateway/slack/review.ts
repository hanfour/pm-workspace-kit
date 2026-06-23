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
import type { WebClient } from "@slack/web-api";
import type { GatewayConfig } from "../config";
import {
  resolveReviewConfig,
  resolveGithubToken,
  resolveReviewGhToken,
  reviewWorkspaceDir,
} from "../config";
import { appendGatewayEvent } from "../events";
import { parsePrRefs, type PrRef } from "../pr-ref";
import { claimReview, finalizeReview, releaseReview } from "../review-claim";
import {
  resolveProjectByRemote as resolveProjectByRemoteImpl,
  runMraReview as runMraReviewImpl,
} from "../../adapters/mra";
import {
  resolveRepoSlug as resolveRepoSlugImpl,
  repoVisibility as repoVisibilityImpl,
  getAuthUser as getAuthUserImpl,
  getPrHead as getPrHeadImpl,
} from "../../adapters/github";
import {
  prepareReviewClone as prepareReviewCloneImpl,
  teardownReviewClone as teardownReviewCloneImpl,
  ensureReviewWorkspaceMeta as ensureReviewWorkspaceMetaImpl,
} from "../review-workspace";

export interface ReviewGateway {
  resolveProjectByRemote: typeof resolveProjectByRemoteImpl;
  runMraReview: typeof runMraReviewImpl;
  resolveRepoSlug: typeof resolveRepoSlugImpl;
  repoVisibility: typeof repoVisibilityImpl;
  getAuthUser: typeof getAuthUserImpl;
  getPrHead: typeof getPrHeadImpl;
  prepareReviewClone: typeof prepareReviewCloneImpl;
  teardownReviewClone: typeof teardownReviewCloneImpl;
  ensureReviewWorkspaceMeta: typeof ensureReviewWorkspaceMetaImpl;
}

export const realReviewGateway: ReviewGateway = {
  resolveProjectByRemote: resolveProjectByRemoteImpl,
  runMraReview: runMraReviewImpl,
  resolveRepoSlug: resolveRepoSlugImpl,
  repoVisibility: repoVisibilityImpl,
  getAuthUser: getAuthUserImpl,
  getPrHead: getPrHeadImpl,
  prepareReviewClone: prepareReviewCloneImpl,
  teardownReviewClone: teardownReviewCloneImpl,
  ensureReviewWorkspaceMeta: ensureReviewWorkspaceMetaImpl,
};

/**
 * True when a message is an inline `:cr:` review request: it contains the
 * `:cr:` token AND at least one GitHub PR link. Requiring BOTH avoids
 * false-firing review on a stray PR link in ordinary chat. (option B-lite gate)
 */
export function isReviewRequest(text: string): boolean {
  return text.includes(":cr:") && parsePrRefs(text).length > 0;
}

export interface ReviewCoordinatorOptions {
  web: WebClient;
  config: GatewayConfig;
  onLog: (m: string) => void;
  gateway: ReviewGateway;
}

export class ReviewCoordinator {
  constructor(private readonly opts: ReviewCoordinatorOptions) {}

  private async reply(channel: string, threadTs: string, text: string): Promise<void> {
    try {
      await this.opts.web.chat.postMessage({ channel, thread_ts: threadTs, text });
    } catch (err) {
      this.opts.onLog(`review: reply failed: ${(err as Error).message}`);
    }
  }

  /** Whether the `:cr:` review flow is enabled (config-gated). */
  isEnabled(): boolean {
    return resolveReviewConfig(this.opts.config.review).enabled;
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

  /** Shared core: parse PR refs from the text, then review each (fail-soft). */
  private async processReviewRequest(args: {
    channelId: string;
    threadTs: string;
    actorUserId: string;
    text: string;
  }): Promise<void> {
    const { channelId, threadTs, actorUserId, text } = args;
    const { config, gateway, onLog } = this.opts;
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
    });

    // Immediate ack — the review runs detached (minutes), so without this the
    // user gets no feedback until the first PR finishes and may re-send.
    await this.reply(
      channelId,
      threadTs,
      `:mag: 收到，背景 review ${refs.length} 個 PR…（完成後逐一回報；你可以繼續聊或再發）`,
    );

    const reviewWorkspace = reviewWorkspaceDir(); // ~/.pmk/review-workspace
    gateway.ensureReviewWorkspaceMeta(workspace, reviewWorkspace);
    // Pinned review token (stable identity, independent of the host's active
    // gh account) takes priority; fall back to the issue-flow github token, else
    // undefined → host ambient gh. Used for ALL review gh calls + mra's POST.
    const token = resolveReviewGhToken(config.review) ?? resolveGithubToken(config.github);

    for (const ref of refs) {
      await this.reviewOne(ref, {
        channelId,
        threadTs,
        reactorUserId: actorUserId,
        workspace,
        reviewWorkspace,
        review,
        token,
      });
    }
  }

  private async reviewOne(
    ref: PrRef,
    ctx: {
      channelId: string;
      threadTs: string;
      reactorUserId: string;
      workspace: string;
      reviewWorkspace: string;
      review: ReturnType<typeof resolveReviewConfig>;
      token?: string;
    },
  ): Promise<void> {
    const { gateway, onLog } = this.opts;
    const slugDisplay = `${ref.owner}/${ref.repo}`;

    const skip = async (reason: string, msg: string): Promise<void> => {
      appendGatewayEvent({
        type: "review.skipped",
        actor: ctx.reactorUserId,
        repo: slugDisplay,
        pr: ref.number,
        reason,
      });
      await this.reply(ctx.channelId, ctx.threadTs, msg);
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
    };
    if (!claimReview(claimRef)) {
      onLog(`review: already done ${slug}#${ref.number}@${head.sha.slice(0, 8)}`);
      return;
    }

    let posted = false;
    try {
      const prep = await gateway.prepareReviewClone({
        mainClone: `${ctx.workspace}/${project}`,
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
      const res = await gateway.runMraReview(
        {
          workspace: ctx.reviewWorkspace,
          project,
          pr: ref.number,
          strategy: ctx.review.strategy,
          cwd: ctx.reviewWorkspace,
          ghToken: ctx.token, // pin mra's POST identity (GH_TOKEN), stable vs active gh
        },
        { onProgress: (line) => onLog(`mra review ${slug}#${ref.number}: ${line}`) },
      );
      if (!res.ok) {
        await skip(
          "mra-failed",
          `:warning: PR #${ref.number} review 失敗：${res.reason ?? "unknown"}`,
        );
        return;
      }

      posted = true;
      finalizeReview(claimRef, { status: res.status });
      appendGatewayEvent({
        type: "review.posted",
        actor: ctx.reactorUserId,
        repo: slug,
        pr: ref.number,
        status: res.status ?? "COMMENT",
        commentCount: res.commentCount ?? 0,
        durationMs: Date.now() - t0,
      });
      await this.reply(
        ctx.channelId,
        ctx.threadTs,
        `:white_check_mark: 已對 ${slug}#${ref.number} 貼 review（${res.status ?? "COMMENT"}，${res.commentCount ?? 0} 則）：${ref.url}`,
      );
    } catch (err) {
      await skip(
        "error",
        `:warning: PR #${ref.number} review 例外：${(err as Error).message}`,
      );
    } finally {
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
