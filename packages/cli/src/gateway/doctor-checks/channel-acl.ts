import type { DoctorCheckResult, DoctorContext } from "../doctor";

export async function channelAclCheck(
  ctx: DoctorContext,
): Promise<DoctorCheckResult> {
  const channels = ctx.config?.audience?.channels ?? {};
  const channelCount = Object.keys(channels).length;
  // v0.7 default: bot replies to any DM unless the user is blocked. So
  // "0 channels + 0 blocks" is still a working config — it just means
  // the bot is DM-only. Surface as a WARN so the host knows to add
  // channel ACLs if they want @-mention coverage; not a FAIL.
  if (channelCount === 0) {
    return {
      name: "channel-acl",
      severity: "warn",
      message: "no channels configured; bot will only respond in DMs",
      hint: "pmk gateway audience set-channel <channelId> <tier> to enable @-mention in a channel",
    };
  }
  return {
    name: "channel-acl",
    severity: "pass",
    message: `${channelCount} channel(s) configured for @-mention`,
  };
}
