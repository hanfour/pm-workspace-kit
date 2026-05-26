import type { DoctorCheckResult, DoctorContext } from "../doctor";

export async function slackBotTokenCheck(
  ctx: DoctorContext,
): Promise<DoctorCheckResult> {
  const token = ctx.config?.slack?.botToken;
  if (!token) {
    return {
      name: "slack-bot-token",
      severity: "fail",
      message: "no Bot User OAuth Token (xoxb-...) in gateway config",
      hint: "run: pmk gateway init",
    };
  }
  const res = await ctx.runners.slackBotAuth(token);
  if (!res.ok) {
    return {
      name: "slack-bot-token",
      severity: "fail",
      message: `Bot Token rejected by Slack: ${res.error ?? "unknown"}`,
      hint: "re-install the app from manifest to re-issue the token",
    };
  }
  // Scope-by-scope diff isn't done here because auth.test doesn't return
  // scopes; manifest-alignment.ts compares the repo-side manifest against
  // expectedScopes(), which is the source of truth for what was granted
  // at install time.
  return {
    name: "slack-bot-token",
    severity: "pass",
    message: `Bot Token accepted (team=${res.team ?? "?"}, user=${res.user ?? "?"})`,
  };
}
