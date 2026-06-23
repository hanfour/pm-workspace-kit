import type { DoctorCheck, DoctorCheckResult } from "../doctor";
import { resolveReviewConfig } from "../config";
import { findMraBinary } from "../../adapters/mra";
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

  const mraPresent = !!findMraBinary();
  const ghPresent = !!findGhBinary();
  const problems: string[] = [];
  if (!mraPresent) problems.push("mra not on PATH");
  if (!ghPresent) problems.push("gh not on PATH");

  const warnings: string[] = [];
  if (!review.expectedGhUser) {
    warnings.push(
      "review.expectedGhUser unset — actor verification skipped at review time",
    );
  }

  const detail = `mra=${mraPresent ? "found" : "missing"}; gh=${ghPresent ? "found" : "missing"}; strategy=${review.strategy}`;
  const severity = problems.length ? "fail" : warnings.length ? "warn" : "pass";
  const message = problems.length
    ? `${detail} — ${problems.join("; ")}`
    : warnings.length
      ? `${detail}; ${warnings.join("; ")}`
      : detail;

  return { name: "review", severity, message };
};
