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
import { ReviewProgress } from "./review-progress";
import {
  resolveReviewConfig,
  resolveGithubToken,
  resolveReviewGhToken,
  reviewWorkspaceDir,
} from "../config";
import { appendGatewayEvent } from "../events";
import { parsePrRefs, type PrRef } from "../pr-ref";
import { claimReview, finalizeReview, releaseReview, type ReviewRef } from "../review-claim";
import {
  resolveProjectByRemote as resolveProjectByRemoteImpl,
  runMraReview as runMraReviewImpl,
  runMraAnalyze as runMraAnalyzeImpl,
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

/** Fields of an mra review result that shape the Slack result line. */
interface ReviewOutcome {
  status?: string;
  commentCount?: number;
}

/** Result line for a plain `:cr:` review (reports whatever status mra posted). */
export function reviewResultText(slug: string, ref: PrRef, res: ReviewOutcome): string {
  return `:white_check_mark: 已對 ${slug}#${ref.number} 貼 review（${res.status ?? "COMMENT"}，${res.commentCount ?? 0} 則）：${ref.url}`;
}

/**
 * Result line for a `:a:` approve. Three-way on the mra status: the batch-fallback
 * path (review.sh) posts individual comments and prints NO `status:` line, so
 * `status` is undefined there — we must NOT claim "發現重大問題 / 未 approve" then,
 * because GitHub may in fact have recorded an APPROVE. Point the user to the PR
 * instead of asserting a verdict we can't read.
 */
export function approveResultText(slug: string, ref: PrRef, res: ReviewOutcome): string {
  const cc = res.commentCount ?? 0;
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
 * Turn an mra failure into something actionable. mra runs `claude` under
 * `set -euo pipefail` with `2>/dev/null`, so a non-zero claude exit becomes a
 * silent `mra exited with code=1` with no stderr — `detail` then falls back to
 * the last stdout phase (e.g. "running Claude") so the Slack message says WHERE
 * it died; `logDump` records the full picture for the operator's gateway log.
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
      : "stderr=(empty — mra likely swallowed claude's error via 2>/dev/null)",
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
  return t === "retry" || t === "重試" || t === "重跑";
}

export interface ReviewCoordinatorOptions {
  web: WebClient;
  config: GatewayConfig;
  onLog: (m: string) => void;
  gateway: ReviewGateway;
  /** Injectable sleep for the transient-failure retry backoff (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

/** A review currently running detached — tracked so shutdown can drain it (A). */
interface InFlightReview {
  claimRef: ReviewRef;
  controller: AbortController;
  label: string;
  /** Where to post the "interrupted by restart" notice on shutdown (B). */
  channelId: string;
  threadTs: string;
}

export class ReviewCoordinator {
  /** Reviews running right now (detached). Drained on shutdown (A). */
  private readonly inFlight = new Set<InFlightReview>();

  constructor(private readonly opts: ReviewCoordinatorOptions) {}

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
   * Inline `:a:` in a DM or @-mention message → fast review then approve if
   * no high-severity issue found. The caller gates with `isEnabled()` +
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

    const reviewWorkspace = reviewWorkspaceDir();
    gateway.ensureReviewWorkspaceMeta(workspace, reviewWorkspace);
    const token = resolveReviewGhToken(config.review) ?? resolveGithubToken(config.github);

    for (const ref of refs) {
      await this.runOne(ref, {
        channelId,
        threadTs,
        reactorUserId: actorUserId,
        workspace,
        reviewWorkspace,
        review,
        token,
      }, "approve");
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
    if (!resolveReviewConfig(this.opts.config.review).enabled) return;
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
    if (approve) await this.processApproveRequest(req);
    else await this.processReviewRequest(req);
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

    const reviewWorkspace = reviewWorkspaceDir(); // ~/.pmk/review-workspace
    gateway.ensureReviewWorkspaceMeta(workspace, reviewWorkspace);
    // Pinned review token (stable identity, independent of the host's active
    // gh account) takes priority; fall back to the issue-flow github token, else
    // undefined → host ambient gh. Used for ALL review gh calls + mra's POST.
    const token = resolveReviewGhToken(config.review) ?? resolveGithubToken(config.github);

    for (const ref of refs) {
      await this.runOne(ref, {
        channelId,
        threadTs,
        reactorUserId: actorUserId,
        workspace,
        reviewWorkspace,
        review,
        token,
      }, "review");
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
    },
    mode: "review" | "approve",
  ): Promise<void> {
    const { gateway, onLog } = this.opts;
    const isApprove = mode === "approve";
    const verb = isApprove ? "approve" : "review";
    // approve always runs the fast single-agent pass; :cr: honors the config
    // strategy. The progress-bar pacing MUST match the strategy actually run,
    // else a fast approve creeps at the slow debate cadence (and never reaches
    // the result before jumping to done).
    const strategy = isApprove ? "standard" : ctx.review.strategy;
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
      // Idempotency: this exact commit was already reviewed. Don't re-review
      // (avoids duplicate posts) — but DON'T be silent: the user got the "收到"
      // ack, so tell them why no result follows. (Benign; no review.skipped
      // event so it doesn't read as a failure.)
      onLog(`review: already done ${slug}#${ref.number}@${head.sha.slice(0, 8)}`);
      await this.reply(
        ctx.channelId,
        ctx.threadTs,
        `:information_source: ${slug}#${ref.number} 這個 commit（\`${head.sha.slice(0, 7)}\`）已經 review 過了，略過（同一 commit 不重複審）。要重審請推新 commit 後再發。`,
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
      if (gateway.pkbNeedsBuild(mainClone)) {
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
        ghToken: ctx.token, // pin mra's POST identity (GH_TOKEN), stable vs active gh
        signal: controller.signal, // A: shutdown aborts → SIGTERM the review child
        // :a: is the explicit per-invocation opt-in to approve; :cr: honors the
        // config gate. approveIfNoHigh only makes sense on the approve path.
        allowApprove: isApprove ? true : ctx.review.allowApprove,
        ...(isApprove ? { approveIfNoHigh: true } : {}),
      };
      const onProgress = (line: string) => {
        onLog(`mra ${verb} ${slug}#${ref.number}: ${line}`);
        progress?.onLine(line);
      };
      let res = await gateway.runMraReview(mraArgs, { onProgress });
      let retried = false;
      // Retry once on a transient failure. mra runs `claude` under set -e with
      // 2>/dev/null, so an intermittent non-zero claude exit (rate-limit /
      // overload under concurrent load) surfaces as a bare `exited with code=1`
      // and kills the whole review — a single-pass approve has no internal retry,
      // so one blip = total failure. A short backoff + one re-run recovers it.
      // Skip the retry if the run was aborted (shutdown drain) — that's not
      // transient, and the clone is about to be torn down.
      if (!res.ok && !controller.signal.aborted) {
        onLog(
          `mra ${verb} ${slug}#${ref.number} 第一次失敗，${MRA_RETRY_BACKOFF_MS / 1000}s 後重試一次 — ${describeMraFailure(res).logDump}`,
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
      const resultText = isApprove
        ? approveResultText(slug, ref, res)
        : reviewResultText(slug, ref, res);
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
