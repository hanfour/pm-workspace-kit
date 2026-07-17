import type { ReviewProviderMode, ReviewStrategy } from "../adapters/mra";
import type { ProtectionExemption } from "./config";

// Release veto — LIFTED (#90, 2026-07-17): config writers
// (saveGatewayConfig) and the approve POST critical section
// (publishApprovalReservation) now share the cross-process authorization
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
