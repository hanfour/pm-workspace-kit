import type { ReviewProviderMode, ReviewStrategy } from "../adapters/mra";
import type { ProtectionExemption } from "./config";

// Release veto — LIFTED (#90, 2026-07-17): config writers
// (saveGatewayConfig) and the approve POST critical section
// (ApproveFlow.publishReservation) now share the cross-process authorization
// lock (gateway/authorization-lock.ts), closing the TOCTOU the veto guarded
// against. GitHub APPROVE additionally requires the runtime gate
// `review.approval.enabled` (admin-togglable, default false) plus the
// per-approve preflights (identity, head-SHA, protection, revision fences).
// The protection preflight is waivable per-repo via
// `review.approval.protectionExemptions` — a deliberate, reasoned risk
// acceptance for repos whose ruleset lacks dismiss-stale/require-last-push.
// See docs/superpowers/specs/2026-07-17-approve-protection-exemption-design.md.
export const AUTOMATIC_APPROVAL_RELEASE_READY = true;

export function effectiveMraReviewStrategy(
  configured: ReviewStrategy,
  providerMode: ReviewProviderMode,
  isApprove: boolean,
): ReviewStrategy {
  if (isApprove) return "standard";
  if (providerMode === "claude") return configured;
  return "standard";
}

export function reviewStrategySummary(
  configured: ReviewStrategy,
  providerMode: ReviewProviderMode,
): string {
  const cr = effectiveMraReviewStrategy(configured, providerMode, false);
  const approve = effectiveMraReviewStrategy(configured, providerMode, true);
  return `strategy configured \`${configured}\` · effective :cr: \`${cr}\` · :a: \`${approve}\``;
}

/**
 * The per-repo waiver of the branch-protection preflight, or undefined.
 *
 * Returns the entry rather than a boolean so callers get `reason` for the
 * Slack disclosure and the audit record. Exact slug match only: a stored
 * `onead/*` is a literal repo name that matches nothing, by design.
 */
export function findProtectionExemption(
  approval: { protectionExemptions?: ProtectionExemption[] },
  slug: string,
): ProtectionExemption | undefined {
  return approval.protectionExemptions?.find((e) => e.repo === slug);
}

/**
 * The refusal shown when approve preflight finds the repo not approval-ready.
 *
 * Two very different situations reach this point and the old single sentence
 * covered both, leaving the reader nothing to act on — one admin retried the
 * same `approve` seven times over two hours against an underprotected repo.
 *
 * `approvalProtectionReady` returning false already establishes that the two
 * controls are not both on, so that is the default explanation — it holds even
 * when the gate probe was never consulted (the flag is off). The probe only
 * adds one distinction: if it ran and came back unknown, the Rules API is
 * unreadable, which also makes the `false` above untrustworthy. Say that
 * instead of naming controls we could not actually observe.
 *
 * @param gateStatus probe result; meaningful only when `gateProbed` is true
 * @param gateProbed whether the gate probe was consulted at all
 */
export function protectionNotReadyMessage(
  slug: string,
  branch: string,
  gateStatus: boolean | undefined,
  gateProbed = false,
): string {
  if (gateProbed && gateStatus === undefined) {
    return (
      `無法確認 ${slug} 的 \`${branch}\` 保護狀態（Rules API 讀取失敗），` +
      "為安全起見不予核准。請 repo admin 確認 pmk 的 review 身分是否有讀取權限；" +
      "在確認之前，請直接在 GitHub 上人工核准。"
    );
  }
  return (
    `${slug} 的 \`${branch}\` 需要 review 核准，但缺少兩項必要保護：` +
    "`dismiss_stale_reviews_on_push` 與 `require_last_push_approval`（目前皆為 false）。" +
    "少了它們，核准後推的新 commit 不會讓核准失效，未經審查的變更就能合併。\n" +
    "請 repo admin 於 ruleset 開啟這兩項；" +
    "若需在調整前先行放行，請 PMK admin 將此 repo 加入 `review.approval.protectionExemptions`。" +
    "在此之前，請直接在 GitHub 上人工核准。"
  );
}
