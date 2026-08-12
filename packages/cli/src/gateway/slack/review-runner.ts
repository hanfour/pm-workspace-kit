/**
 * Runs one PR review to completion, tracks it while in flight, and drains it
 * on shutdown.
 *
 * runOne is an acquire → work → release bracket: claim, in-flight
 * registration, progress bar, workspace clone. Its correctness protocol is
 * that every early exit passes through the `finally`, which reads `posted` to
 * decide whether the claim survives as an idempotency record or is released
 * for retry. That is why the bracket is NOT split — it moved whole, and the
 * state it owns (`inFlight`) moved with it.
 */
import { markPriorReviewComments } from "../../adapters/github";
import type { WebClient } from "@slack/web-api";
import type { GatewayConfig, resolveReviewConfig } from "../config";
import { appendGatewayEvent } from "../events";
import type { PrRef } from "../pr-ref";
import { claimReview, forceClaimReview, finalizeReview, readFinalizedReview, releaseReview, type ReviewRef } from "../review-claim";
import { peekApprovalOffer, saveApprovalOffer } from "../review-approval";
import { isAdmin } from "../config";
import { effectiveMraReviewStrategy, findProtectionExemption } from "../review-policy";
import type { ReviewGateway } from "./review";
import { admissionRefusal, admissionRefusalMessage } from "./review-admission";
import { resolveReviewTarget } from "./review-target";
import {
  alreadyReviewedMessage,
  canConfirmApproveFromReview,
  reviewResultText,
  approveResultText,
  describeMraFailure,
} from "./review-messages";
import {
  buildReviewMraArgs,
  runMraReviewWithRetry,
  postProtocolV1Review,
} from "./review-backend";
import { ReviewProgress } from "./review-progress";

export interface ReviewRunnerDeps {
  gateway: ReviewGateway;
  web: WebClient;
  onLog: (m: string) => void;
  /** Injectable sleep for the retry backoff; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * MUST stay a function. runOne re-reads live config at post time to
   * re-validate policy before the GitHub POST; a snapshot would let a revoked
   * policy through.
   */
  currentConfig: () => GatewayConfig;
  reply: (ch: string, threadTs: string, text: string) => Promise<void>;
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

export class ReviewRunner {
  /** Reviews running right now (detached). Drained on shutdown (A). */
  private readonly inFlight = new Set<InFlightReview>();

  constructor(private readonly deps: ReviewRunnerDeps) {}

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
      void this.deps.reply(
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
    const sleep = this.deps.sleep ?? ((m: number) => new Promise<void>((r) => setTimeout(r, m)));
    await sleep(ms);
  }

  /** Like reply() but returns the posted message ts (for in-place progress edits). */
  private async replyWithTs(channel: string, threadTs: string, text: string): Promise<string | undefined> {
    try {
      const res = (await this.deps.web.chat.postMessage({ channel, thread_ts: threadTs, text })) as { ts?: string };
      return res.ts;
    } catch (err) {
      this.deps.onLog(`review: reply failed: ${(err as Error).message}`);
      return undefined;
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
  async runOne(
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
      /** Which command the user typed; only affects wording. */
      origin?: "cr" | "a";
    },
    mode: "review" | "approve",
  ): Promise<void> {
    const { gateway, onLog } = this.deps;
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
      else await this.deps.reply(ctx.channelId, ctx.threadTs, msg);
    };

    // Every pre-claim guard (workspace, slug, head, approve-head authorisation,
    // allowlist, visibility) lives in resolveReviewTarget. Refusals never reach
    // a claim, so a rejected PR does not burn one.
    const target = await resolveReviewTarget(ref, ctx, gateway);
    if (!target.ok) {
      await skip(target.reason, target.message);
      return;
    }
    const { project, slug, head } = target;

    const slugParts = slug.split("/");
    const [slugOwner, slugRepo] =
      slugParts.length === 2
        ? slugParts
        : [ref.owner, ref.repo];
    // No contextVersion: the claim identifies the COMMIT, and head.updatedAt
    // moves on any PR activity — including the review this run is about to
    // post. Keying on it re-opened the same commit for review (see
    // reviewClaimKey).
    const claimRef = {
      owner: slugOwner,
      repo: slugRepo,
      pr: ref.number,
      headSha: head.sha,
      intent: isApprove ? "approve" as const : "review" as const,
    };
    const projectKey = `${slugOwner}/${slugRepo}`;
    // Which of the three limits fired is decided in review-admission, so the
    // reply can name it instead of listing all three joined by "或".
    const refusal = admissionRefusal(this.inFlight, {
      actorUserId: ctx.reactorUserId,
      projectKey,
      maxConcurrent: ctx.review.maxConcurrent,
      maxConcurrentPerUser: ctx.review.maxConcurrentPerUser,
    });
    if (refusal) {
      await skip("busy", admissionRefusalMessage(refusal));
      return;
    }
    const claimed = ctx.forceRerun ? forceClaimReview(claimRef) : claimReview(claimRef);
    if (!claimed) {
      // Idempotency: this exact commit was already reviewed. Don't re-review
      // (avoids duplicate posts) — but DON'T be silent: the user got the "收到"
      // ack, so tell them why no result follows. (Benign; no review.skipped
      // event so it doesn't read as a failure.)
      onLog(`review: already done ${slug}#${ref.number}@${head.sha.slice(0, 8)}`);
      // An offer for THIS commit means the work the user is re-triggering is
      // not just done, it is waiting on one word from them. Match on headSha:
      // an offer left over from an earlier commit is not a way forward for this
      // one, and pointing at it would authorize the wrong code.
      const offerPending = (peekApprovalOffer(ctx.channelId, ctx.threadTs) ?? []).some(
        (o) =>
          o.owner === slugOwner && o.repo === slugRepo &&
          o.number === ref.number && o.headSha === head.sha,
      );
      await this.deps.reply(
        ctx.channelId,
        ctx.threadTs,
        alreadyReviewedMessage({
          slug,
          pr: ref.number,
          headSha: head.sha,
          intent: mode,
          origin: ctx.origin,
          prior: readFinalizedReview(claimRef),
          approveOfferPending: offerPending,
          isAdmin: isAdmin(this.deps.currentConfig(), ctx.reactorUserId),
        }),
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
          web: this.deps.web, channel: ctx.channelId, ts: progressTs,
          strategy, headline, onLog: this.deps.onLog,
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

      // A reply that refutes an earlier finding lives on GitHub, and mra's
      // analysis stage runs with no credential by design — so it is fetched
      // here and carried in the request. `actor` is the account the review
      // posts as, which is what separates our own prior findings from
      // everybody else's comments: mra reviews under a human's token, so
      // authorship alone identifies nothing.
      // Best-effort, like every other part of this: a review that cannot read
      // the discussion still runs, it just runs without the benefit. Failing
      // here would trade a missing rebuttal for no review at all.
      const discussion = await gateway
        .listPrDiscussion({ slug, pr: ref.number, token: ctx.token })
        .then((items) => markPriorReviewComments(items, actor ?? undefined))
        .catch(() => []);

      const t0 = Date.now();
      const mraArgs = buildReviewMraArgs({
        reviewWorkspace: ctx.reviewWorkspace,
        project,
        pr: ref.number,
        strategy,
        providerMode: ctx.review.providerMode,
        head,
        baseRef: prep.baseRef,
        signal: controller.signal,
        discussion,
      });
      const onProgress = (line: string) => {
        onLog(`mra ${verb} ${slug}#${ref.number}: ${line}`);
        progress?.onLine(line);
      };
      // Invoke the backend with the transient-failure / REVIEW_INCOMPLETE retry
      // policy; res.status may be reassigned below on the protocol-v1 path.
      const { res, retried } = await runMraReviewWithRetry(gateway, mraArgs, {
        onProgress,
        onLog,
        backoff: (ms, signal) => this.backoff(ms, signal),
        signal: controller.signal,
        label: `${verb} ${slug}#${ref.number}`,
      });
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
        // Re-validate live policy + head at post time, then POST the GitHub review.
        const posting = await postProtocolV1Review(gateway, {
          config: this.deps.currentConfig(),
          slug,
          ref,
          headSha: head.sha,
          reactorUserId: ctx.reactorUserId,
          res,
        });
        if (!posting.ok) {
          await skip(posting.reason, posting.message);
          return;
        }
        res.status = posting.status;
      }

      posted = true;
      // Record the verdict, not just "done": a later trigger on this same commit
      // has to be able to say WHAT was decided, or its skip note reads as "your
      // push was ignored" to the person who just pushed the fix.
      finalizeReview(claimRef, {
        status: res.status,
        reviewUrl: ref.url,
        blockerCount: res.blockerCount,
        commentCount: res.commentCount,
      });
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
        : reviewResultText(slug, ref, res, ctx.review.approval.enabled,
            !!findProtectionExemption(ctx.review.approval, slug), ctx.origin);
      if (progress) await progress.finish(resultText);
      else await this.deps.reply(ctx.channelId, ctx.threadTs, resultText);
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
}
