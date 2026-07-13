import type { ReviewProviderMode, ReviewStrategy } from "../adapters/mra";

// Release veto: the analysis/review integration is production-ready, but a
// GitHub APPROVE mutation remains disabled until config writers and the POST
// path share one cross-process authorization lock.
export const AUTOMATIC_APPROVAL_RELEASE_READY = false;

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
