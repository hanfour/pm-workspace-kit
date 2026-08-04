/**
 * The pre-claim decision: may this PR be reviewed at all, and against what?
 *
 * Six guards run in order — workspace membership, GitHub slug, PR head, the
 * approve-time head authorisation, the repo allowlist, and repo visibility.
 * Two of them are containment controls rather than conveniences: the allowlist,
 * and the refusal to review a public repo (which would publish internal
 * analysis into a public PR).
 *
 * Extracted from `runOne`, where these 68 lines sat inside 320 alongside the
 * claim, the progress bar, the workspace clone and the mra backend — so
 * exercising a single guard meant driving all of it. They belong together and
 * apart from that: the decision needs only the gateway and the request, holds
 * no state, and every outcome is a value.
 *
 * All of this happens BEFORE a claim is taken, so a refused PR never burns one.
 * The order matters for the same reason: the allowlist is a local check, the
 * visibility probe is a network round trip, so the cheap refusal goes first.
 */
import type { PrRef } from "../pr-ref";

/** Just enough of the gateway to decide. Keeps the seam small and injectable. */
export interface ReviewTargetGateway {
  resolveProjectByRemote: (workspace: string, slug: string) => string | undefined;
  resolveRepoSlug: (workspace: string, project: string) => Promise<string | undefined>;
  getPrHead: (args: { slug: string; pr: number; token?: string }) => Promise<
    { sha: string; baseRef: string; updatedAt?: string } | undefined
  >;
  repoVisibility: (args: { slug: string; token?: string }) => Promise<string>;
}

export interface ReviewTargetContext {
  workspace: string;
  review: { repoAllowlist?: string[]; allowPublicRepos?: boolean };
  token?: string;
  /**
   * Head SHAs an admin authorised at approve time, keyed `owner/repo#number`.
   * Present only on the approve path.
   */
  authorizedHeads?: Map<string, string>;
}

export type ReviewTarget =
  | {
      ok: true;
      project: string;
      slug: string;
      head: { sha: string; baseRef: string; updatedAt?: string };
    }
  | { ok: false; reason: string; message: string };

export async function resolveReviewTarget(
  ref: PrRef,
  ctx: ReviewTargetContext,
  gateway: ReviewTargetGateway,
): Promise<ReviewTarget> {
  const slugDisplay = `${ref.owner}/${ref.repo}`;

  const project = gateway.resolveProjectByRemote(ctx.workspace, slugDisplay);
  if (!project) {
    return {
      ok: false,
      reason: "not-in-workspace",
      message: `:information_source: \`${slugDisplay}\` 不在 mra workspace，略過 PR #${ref.number}`,
    };
  }

  const slug = await gateway.resolveRepoSlug(ctx.workspace, project);
  if (!slug) {
    return {
      ok: false,
      reason: "slug",
      message: `:warning: 無法從 \`${project}\` 推出 GitHub slug，略過 PR #${ref.number}`,
    };
  }

  const head = await gateway.getPrHead({ slug, pr: ref.number, token: ctx.token });
  if (!head) {
    return {
      ok: false,
      reason: "pr-head",
      message: `:warning: 取不到 PR #${ref.number} 的 head，略過`,
    };
  }

  // The approve path authorised ONE commit. A newer one means the admin would
  // be approving code nobody reviewed.
  const authorizedHead = ctx.authorizedHeads?.get(`${ref.owner}/${ref.repo}#${ref.number}`);
  if (authorizedHead && authorizedHead !== head.sha) {
    return {
      ok: false,
      reason: "approval-head-changed",
      message: `:warning: PR #${ref.number} 在 approve 授權後已有新 commit；未 approve，請重新執行 :cr:。`,
    };
  }

  if (ctx.review.repoAllowlist && !ctx.review.repoAllowlist.includes(slug)) {
    return {
      ok: false,
      reason: "allowlist",
      message: `:no_entry: \`${slug}\` 不在 review allowlist，略過 PR #${ref.number}`,
    };
  }

  if (!ctx.review.allowPublicRepos) {
    const vis = await gateway.repoVisibility({ slug, token: ctx.token });
    // Anything that is not positively private fails closed — "unknown" is not
    // permission to publish internal analysis.
    if (vis !== "private") {
      return {
        ok: false,
        reason: "public-repo",
        message: `:no_entry: \`${slug}\` 為 public（或無法判定），略過 PR #${ref.number} 以免外洩`,
      };
    }
  }

  return { ok: true, project, slug, head };
}
