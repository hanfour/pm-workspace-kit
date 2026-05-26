import type { DoctorCheckResult, DoctorContext } from "../doctor";

export async function mraWorkspaceCheck(
  ctx: DoctorContext,
): Promise<DoctorCheckResult> {
  const workspace = ctx.config?.mraWorkspace;
  if (!workspace) {
    return {
      name: "mra-workspace",
      severity: "warn",
      message: "no mraWorkspace set; mra-ask escalation will fall back to launch cwd",
      hint: "set mraWorkspace in ~/.pmk/gateway.json to the dir containing .collab/repos.json",
    };
  }
  const res = await ctx.runners.mraList(workspace);
  if (!res.ok) {
    return {
      name: "mra-workspace",
      severity: "fail",
      message: `mra workspace unusable: ${res.error ?? "unknown"}`,
      hint: `verify the path exists and contains .collab/repos.json: ${workspace}`,
    };
  }
  if (res.repos.length === 0) {
    return {
      name: "mra-workspace",
      severity: "warn",
      message: `mra workspace ${workspace} has 0 repos registered`,
      hint: "register repos via mra, then re-run doctor",
    };
  }
  return {
    name: "mra-workspace",
    severity: "pass",
    message: `mra workspace ${workspace} lists ${res.repos.length} repo(s)`,
  };
}
