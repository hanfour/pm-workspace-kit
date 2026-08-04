/**
 * The review *backend* seam extracted from ReviewRunner.runOne: building the
 * mra review argv, invoking it with the transient-failure / REVIEW_INCOMPLETE
 * retry policy, and — for protocol-v1 (codex) results — re-validating live policy
 * and posting the GitHub review. These are the provider-facing steps; the
 * runner keeps the claim lifecycle, progress bar, and Slack replies.
 *
 * Everything the runner would reach via `this` (gateway, backoff, live
 * config) is passed in explicitly, so these functions are testable in isolation
 * and free of the runner's state.
 */
import {
  type MraReviewResult,
  type ReviewStrategy,
  type ReviewProviderMode,
  runMraReview as runMraReviewImpl,
} from "../../adapters/mra";
import type { ReviewGateway } from "./review";
import { describeMraFailure } from "./review-messages";
import {
  resolveReviewConfig,
  resolveReviewGhToken,
  resolveGithubToken,
  type GatewayConfig,
} from "../config";
import type { PrRef } from "../pr-ref";

/** Backoff before a single transient-failure retry of the mra review call. */
export const MRA_RETRY_BACKOFF_MS = 4000;

/** Argument shape of the mra review adapter, kept in sync via its own type. */
type MraReviewArgs = Parameters<typeof runMraReviewImpl>[0];

/** Build the mra review argv object for a single PR. Pure. */
export function buildReviewMraArgs(params: {
  reviewWorkspace: string;
  project: string;
  pr: number;
  strategy: ReviewStrategy;
  providerMode?: ReviewProviderMode;
  head: { sha: string; baseSha?: string; title?: string; body?: string; updatedAt?: string };
  baseRef: string;
  signal: AbortSignal;
}): MraReviewArgs {
  return {
    workspace: params.reviewWorkspace,
    project: params.project,
    pr: params.pr,
    strategy: params.strategy,
    cwd: params.reviewWorkspace,
    providerMode: params.providerMode,
    expectedHeadSha: params.head.sha,
    baseRef: params.baseRef,
    baseSha: params.head.baseSha,
    prContext: { title: params.head.title, body: params.head.body, updatedAt: params.head.updatedAt },
    signal: params.signal, // shutdown aborts → SIGTERM the review child
  };
}

/**
 * Invoke the mra review, retrying once on a transient failure (res.ok=false,
 * e.g. provider overload surfacing as `exited with code=1`) OR a REVIEW_INCOMPLETE
 * (mra EXITs 0 but posts a neutral placeholder). Both routinely recover on re-run.
 * The retry is skipped when the signal is aborted (shutdown drain — not transient).
 */
export async function runMraReviewWithRetry(
  gateway: Pick<ReviewGateway, "runMraReview">,
  mraArgs: MraReviewArgs,
  opts: {
    onProgress: (line: string) => void;
    onLog: (m: string) => void;
    backoff: (ms: number, signal: AbortSignal) => Promise<void>;
    signal: AbortSignal;
    /** `${verb} ${slug}#${pr}` — used in the retry log line. */
    label: string;
  },
): Promise<{ res: MraReviewResult; retried: boolean }> {
  let res = await gateway.runMraReview(mraArgs, { onProgress: opts.onProgress });
  let retried = false;
  if ((!res.ok || res.incomplete) && !opts.signal.aborted) {
    const why = res.ok
      ? "回報 REVIEW_INCOMPLETE"
      : `失敗 — ${describeMraFailure(res).logDump}`;
    opts.onLog(
      `mra ${opts.label} 第一次${why}，${MRA_RETRY_BACKOFF_MS / 1000}s 後重試一次`,
    );
    await opts.backoff(MRA_RETRY_BACKOFF_MS, opts.signal);
    if (!opts.signal.aborted) {
      retried = true;
      res = await gateway.runMraReview(mraArgs, { onProgress: opts.onProgress });
    }
  }
  return { res, retried };
}

/** Skip verdict from {@link postProtocolV1Review} — carries the runner's skip args. */
export type ProtocolV1PostResult =
  | { ok: true; status: string }
  | { ok: false; reason: string; message: string };

/**
 * Protocol-v1 (codex) path: re-validate live policy at post time (it may have
 * been revoked, or the head moved, during the analysis window) and, if still
 * valid, POST the GitHub review. Returns the posted GitHub state on success, or
 * an { ok: false } skip verdict the runner routes through its own skip().
 */
export async function postProtocolV1Review(
  gateway: Pick<ReviewGateway, "getAuthUser" | "getPrHead" | "createPullRequestReview">,
  params: {
    config: GatewayConfig; // live snapshot at post time
    slug: string;
    ref: PrRef;
    headSha: string;
    reactorUserId: string;
    res: MraReviewResult;
  },
): Promise<ProtocolV1PostResult> {
  const { config, slug, ref, headSha, reactorUserId, res } = params;
  const liveReview = resolveReviewConfig(config.review);
  if (!liveReview.enabled || config.blocklist.includes(reactorUserId)) {
    return { ok: false, reason: "policy-revoked", message: ":no_entry: review policy 在分析期間已撤銷，未貼 GitHub review。" };
  }
  if (liveReview.repoAllowlist && !liveReview.repoAllowlist.includes(slug)) {
    return { ok: false, reason: "policy-revoked", message: ":no_entry: repository 已不在 review allowlist，未貼 GitHub review。" };
  }
  const liveToken = resolveReviewGhToken(config.review) ?? resolveGithubToken(config.github);
  const liveActor = await gateway.getAuthUser({ token: liveToken });
  if (!liveActor || (liveReview.expectedGhUser && liveActor !== liveReview.expectedGhUser)) {
    return { ok: false, reason: "gh-actor-revoked", message: ":no_entry: GitHub review identity 在分析期間已改變，未貼 review。" };
  }
  const liveHead = await gateway.getPrHead({ slug, pr: ref.number, token: liveToken });
  if (!liveHead || liveHead.sha !== headSha) {
    return { ok: false, reason: "review-head-changed", message: `:warning: PR #${ref.number} 在分析期間已有新 commit；未貼過期 review。` };
  }
  const postedReview = await gateway.createPullRequestReview({
    slug,
    pr: ref.number,
    commitId: headSha,
    token: liveToken,
    event: res.status === "CHANGES_REQUESTED" ? "REQUEST_CHANGES" : "COMMENT",
    body: `${res.summary ?? "MRA review completed"}\n\nMRA artifact: ${res.artifactSha256}`,
    comments: res.findings ?? [],
  });
  return { ok: true, status: postedReview.state };
}
