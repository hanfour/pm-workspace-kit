import type { DoctorCheck, DoctorCheckResult } from "../doctor";
import { resolveGithubToken } from "../config";
import { findGhBinary } from "../../adapters/github";
import { recoverIssueClaims } from "../issue-candidate";

const STALE_LOCK_MS = 10 * 60 * 1000;

/**
 * github-token check for the confirmed-problem → issue flow. PASSes when
 * github is unconfigured (flow off). When configured: gh present + token
 * resolves → pass, else fail. Also self-heals issue-candidate claim locks
 * (finalizes claiming-with-url; warns on stale bare locks). Never prints the token.
 */
export const githubTokenCheck: DoctorCheck = async (
  ctx,
): Promise<DoctorCheckResult> => {
  const github = ctx.config?.github;
  const warnings: string[] = [];
  recoverIssueClaims(STALE_LOCK_MS, (m) => warnings.push(m));

  if (!github) {
    return {
      name: "github-token",
      severity: warnings.length ? "warn" : "pass",
      message: warnings.length
        ? `github not configured (🎫 issue flow off); ${warnings.join("; ")}`
        : "github not configured (🎫 issue flow off)",
    };
  }

  const ghPresent = !!findGhBinary();
  let token: string | undefined;
  let tokenError: string | undefined;
  try {
    token = resolveGithubToken(github);
  } catch (e) {
    tokenError = (e as Error).message; // SecretResolutionError — no stdout/stderr in it
  }

  const problems: string[] = [];
  if (!ghPresent) problems.push("gh CLI not found on PATH");
  if (tokenError) problems.push(tokenError);
  else if (!token) problems.push("github.token unset / unresolved");

  const detail = [
    `gh=${ghPresent ? "found" : "missing"}`,
    `token=${token ? "resolved" : "unresolved"}`,
    ...warnings,
  ].join("; ");

  return {
    name: "github-token",
    severity: problems.length ? "fail" : warnings.length ? "warn" : "pass",
    message: problems.length ? `${detail} — ${problems.join("; ")}` : detail,
  };
};
