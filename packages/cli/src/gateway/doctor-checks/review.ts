import type { DoctorCheck, DoctorCheckResult } from "../doctor";
import { resolveReviewConfig } from "../config";
import { findMraBinary, mraIntegrationCapabilities, mraSupportsReviewProvider } from "../../adapters/mra";
import { findGhBinary } from "../../adapters/github";

/**
 * review check for the :cr: PR-review flow. PASS when review is disabled
 * (flow off). When enabled: mra + gh present → pass; missing → fail. Warns
 * when expectedGhUser is unset (actor verification is skipped at review time,
 * so a review could post under an unexpected gh identity). Presence/config
 * only — no live gh call (kept fast like github-token).
 */
export const reviewDoctorCheck: DoctorCheck = async (
  ctx,
): Promise<DoctorCheckResult> => {
  const review = resolveReviewConfig(ctx.config?.review);
  if (!review.enabled) {
    return {
      name: "review",
      severity: "pass",
      message: "review off (:cr: PR review disabled)",
    };
  }

  const mraBinary = findMraBinary();
  const mraPresent = !!mraBinary;
  const ghPresent = !!findGhBinary();
  const protocol = mraBinary ? mraIntegrationCapabilities(mraBinary, true) : undefined;
  const problems: string[] = [];
  if (!mraPresent) problems.push("mra not on PATH");
  else if (!protocol && !mraSupportsReviewProvider(mraBinary)) problems.push("mra is too old (review --provider unsupported)");
  if (review.approval.enabled && !protocol) problems.push("automatic approval requires MRA integration protocol v1");
  if (!ghPresent) problems.push("gh not on PATH");

  const warnings: string[] = [];
  if (!review.expectedGhUser) {
    warnings.push(
      "review.expectedGhUser unset — actor verification skipped at review time",
    );
  }
  if (!protocol) warnings.push("legacy MRA bridge is review-only; structured completion and approval are unavailable");

  const detail = `mra=${mraPresent ? "found" : "missing"}; protocol=${protocol ? "v1" : "legacy/unavailable"}; gh=${ghPresent ? "found" : "missing"}; provider=${review.providerMode}; strategy=${review.strategy}; approval=${review.approval.enabled ? "enabled" : "disabled"}`;
  const severity = problems.length ? "fail" : warnings.length ? "warn" : "pass";
  const message = problems.length
    ? `${detail} — ${problems.join("; ")}`
    : warnings.length
      ? `${detail}; ${warnings.join("; ")}`
      : detail;

  return { name: "review", severity, message };
};
