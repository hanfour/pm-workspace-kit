// What the INSTALLED Slack app actually holds, as opposed to what the repo's
// manifest declares. manifest-alignment.ts compares two things the operator's
// workspace never touches (the template file and expectedScopes()), so an app
// installed before a scope was added keeps passing every check.
//
// 2026-08-14, finance-system#378: the live bot token held `im:history` but not
// `channels:history`. Every thread-root re-read in a channel threw
// missing_scope, `rerun` told users their thread had no review, and the `:cr:`
// reaction path posted nothing at all — while `pmk gateway doctor` reported
// zero failures. auth.test returns the granted scopes; this check reads them.
import { expectedScopes } from "../slack/manifest-version";
import type { DoctorCheckResult, DoctorContext } from "../doctor";

export async function slackBotScopesCheck(
  ctx: DoctorContext,
): Promise<DoctorCheckResult> {
  const name = "slack-bot-scopes";
  const token = ctx.config?.slack?.botToken;
  if (!token) {
    return {
      name,
      severity: "fail",
      message: "no Bot User OAuth Token (xoxb-...) to inspect",
      hint: "run: pmk gateway init",
    };
  }
  const res = await ctx.runners.slackBotAuth(token);
  if (!res.ok) {
    return {
      name,
      severity: "fail",
      message: `cannot read granted scopes — Slack rejected the Bot Token: ${res.error ?? "unknown"}`,
      hint: "fix the token first (see slack-bot-token)",
    };
  }
  if (!res.scopes) {
    // Reporting "pass" here would claim knowledge this check does not have.
    return {
      name,
      severity: "warn",
      message: "Slack returned no scope list; granted scopes not verified",
      hint: "compare manually: curl -sD- -o/dev/null -XPOST https://slack.com/api/auth.test -H 'Authorization: Bearer <xoxb-…>' | grep -i x-oauth-scopes",
    };
  }
  const granted = new Set(res.scopes);
  const missing = expectedScopes().filter((s) => !granted.has(s));
  if (missing.length > 0) {
    return {
      name,
      severity: "fail",
      message: `installed Slack app is missing ${missing.length} granted bot scope(s)`,
      hint: `add at api.slack.com/apps → OAuth & Permissions → Bot Token Scopes, then reinstall: ${missing.join(", ")}`,
    };
  }
  return {
    name,
    severity: "pass",
    message: `all ${expectedScopes().length} expected bot scopes granted`,
  };
}
