import type { ReviewProviderMode, ReviewStrategy } from "../adapters/mra";

// Release veto — LIFTED (#90, 2026-07-17): config writers
// (saveGatewayConfig) and the approve POST critical section
// (publishApprovalReservation) now share the cross-process authorization
// lock (gateway/authorization-lock.ts), closing the TOCTOU the veto guarded
// against. GitHub APPROVE additionally requires the runtime gate
// `review.approval.enabled` (admin-togglable, default false) plus the
// per-approve preflights (identity, head-SHA, protection, revision fences).
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
