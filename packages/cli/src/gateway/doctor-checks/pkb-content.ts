import type { DoctorCheckResult, DoctorContext } from "../doctor";

export async function pkbContentCheck(
  ctx: DoctorContext,
): Promise<DoctorCheckResult> {
  const hasDefaultIngest = !!ctx.config?.defaultIngest;
  const hasMraWorkspace = !!ctx.config?.mraWorkspace;
  if (!hasDefaultIngest && !hasMraWorkspace) {
    return {
      name: "pkb-content",
      severity: "fail",
      message: "no PKB source: neither defaultIngest nor mraWorkspace is set",
      hint: "set defaultIngest=mra:--all in gateway.json (or set mraWorkspace)",
    };
  }
  if (!hasDefaultIngest) {
    return {
      name: "pkb-content",
      severity: "warn",
      message: "no defaultIngest configured; new sessions start with empty PKB seed",
      hint: 'set defaultIngest="mra:--all" so first DM/channel turn auto-loads PKB',
    };
  }
  if (!hasMraWorkspace && ctx.config?.defaultIngest?.startsWith("mra:")) {
    return {
      name: "pkb-content",
      severity: "warn",
      message: `defaultIngest=${ctx.config?.defaultIngest} but no mraWorkspace set`,
      hint: "set mraWorkspace so the ingest spec can resolve at runtime",
    };
  }
  return {
    name: "pkb-content",
    severity: "pass",
    message: `defaultIngest="${ctx.config?.defaultIngest}" will seed PKB on first turn`,
  };
}
