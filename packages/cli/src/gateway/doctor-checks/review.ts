import * as fs from "node:fs";

import type { DoctorCheck, DoctorCheckResult } from "../doctor";
import { resolveReviewConfig } from "../config";
import { findMraBinary, mraIntegrationCapabilities, mraSupportsReviewProvider } from "../../adapters/mra";
import { findGhBinary } from "../../adapters/github";

/**
 * Count exemption entries that normalisation threw away. The resolved
 * config keeps no record of a drop, so the raw file is the only source —
 * and a silently-dropped waiver presents as "approve keeps failing the
 * probe" with a config that looks correct to the eye.
 */
function droppedExemptionCount(configPath: string, keptCount: number): number {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as
      { review?: { approval?: { protectionExemptions?: unknown } } };
    const listed = raw.review?.approval?.protectionExemptions;
    if (!Array.isArray(listed)) return 0;
    return Math.max(0, listed.length - keptCount);
  } catch {
    return 0; // unreadable/absent config is another check's problem
  }
}

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

  const exemptions = review.approval.protectionExemptions ?? [];
  if (exemptions.length) {
    warnings.push(
      `protection exemptions active: ${exemptions.map((e) => `${e.repo} (${e.reason})`).join("; ")} — approve on these repos skips branch-protection readiness`,
    );
  }
  const dropped = droppedExemptionCount(ctx.configPath, exemptions.length);
  if (dropped > 0) {
    warnings.push(
      `${dropped} protectionExemption entr${dropped === 1 ? "y" : "ies"} dropped (each needs a non-empty repo and reason)`,
    );
  }

  const detail = `mra=${mraPresent ? "found" : "missing"}; protocol=${protocol ? "v1" : "legacy/unavailable"}; gh=${ghPresent ? "found" : "missing"}; provider=${review.providerMode}; strategy=${review.strategy}; approval=${review.approval.enabled ? "enabled" : "disabled"}; exemptions=${exemptions.length}`;
  const severity = problems.length ? "fail" : warnings.length ? "warn" : "pass";
  const message = problems.length
    ? `${detail} — ${problems.join("; ")}`
    : warnings.length
      ? `${detail}; ${warnings.join("; ")}`
      : detail;

  return { name: "review", severity, message };
};
