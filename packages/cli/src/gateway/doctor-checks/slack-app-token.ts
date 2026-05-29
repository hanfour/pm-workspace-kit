import type { DoctorCheckResult, DoctorContext } from "../doctor";

export async function slackAppTokenCheck(
  ctx: DoctorContext,
): Promise<DoctorCheckResult> {
  const token = ctx.config?.slack?.appToken;
  if (!token) {
    return {
      name: "slack-app-token",
      severity: "fail",
      message: "no App-Level Token (xapp-...) in gateway config",
      hint: "run: pmk gateway init",
    };
  }
  const res = await ctx.runners.slackAppAuth(token);
  if (!res.ok) {
    return {
      name: "slack-app-token",
      severity: "fail",
      message: `App-Level Token rejected by Slack: ${res.error ?? "unknown"}`,
      hint: "regenerate at api.slack.com/apps/<your-app>/general → App-Level Tokens",
    };
  }
  return {
    name: "slack-app-token",
    severity: "pass",
    message: "App-Level Token accepted (connections:write OK)",
  };
}
