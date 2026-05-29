import type { DoctorCheckResult, DoctorContext } from "../doctor";

export async function configFileCheck(
  ctx: DoctorContext,
): Promise<DoctorCheckResult> {
  if (!ctx.configFileStat.exists) {
    return {
      name: "config-file",
      severity: "fail",
      message: `gateway config not found at ${ctx.configPath}`,
      hint: "run: pmk gateway init",
    };
  }
  if (!ctx.config) {
    return {
      name: "config-file",
      severity: "fail",
      message: `gateway config at ${ctx.configPath} could not be parsed`,
      hint: "delete and re-run: pmk gateway init",
    };
  }
  const mode = ctx.configFileStat.mode;
  if (mode != null && mode !== 0o600) {
    return {
      name: "config-file",
      severity: "warn",
      message: `gateway config mode is 0${mode.toString(8)}, expected 0600`,
      hint: `chmod 600 ${ctx.configPath}`,
    };
  }
  return {
    name: "config-file",
    severity: "pass",
    message: `gateway config present at ${ctx.configPath} (mode 0600)`,
  };
}
