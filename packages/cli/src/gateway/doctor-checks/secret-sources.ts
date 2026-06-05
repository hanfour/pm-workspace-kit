import type { DoctorCheck, DoctorCheckResult } from "../doctor";
import { secretDiskLabel, resolveSecret } from "../secret-source";
import { resolveGatewayApiKey } from "../config";

/**
 * Reports disk vs effective source per secret; validates a reference only
 * when it is the effective source (mirrors runtime short-circuit); never leaks
 * stdout/stderr. PASSes "no literal secret sources in gateway.json" when none
 * is a literal string.
 */
export const secretSourcesCheck: DoctorCheck = async (
  ctx,
): Promise<DoctorCheckResult> => {
  const ss = ctx.secretSources;
  const lines: string[] = [];
  let failed = false;

  for (const [name, envName, src] of [
    ["slack.appToken", "PMK_SLACK_APP_TOKEN", ss.appToken],
    ["slack.botToken", "PMK_SLACK_BOT_TOKEN", ss.botToken],
  ] as const) {
    const disk = secretDiskLabel(src);
    const override = process.env[envName];
    const shadowed = override !== undefined;
    const effectiveLabel = shadowed ? "fixed-env" : disk;
    lines.push(`${name}: disk=${disk} effective=${effectiveLabel}`);
    if (!shadowed && src !== undefined && typeof src !== "string") {
      try {
        resolveSecret(src, name);
      } catch (e) {
        failed = true;
        lines.push(`  ${name}: ${(e as Error).message}`);
      }
    }
  }

  const diskApi = secretDiskLabel(ss.apiKey);
  try {
    const { usedCliConfig } = resolveGatewayApiKey(ctx.cliApiKey, ss.apiKey);
    lines.push(
      `apiKey: disk=${diskApi} effective=${usedCliConfig ? "cli-config" : diskApi}`,
    );
  } catch (e) {
    failed = true;
    lines.push(`apiKey: ${(e as Error).message}`);
  }

  const noLiteral = [ss.appToken, ss.botToken, ss.apiKey].every(
    (s) => typeof s !== "string",
  );
  if (noLiteral) lines.push("no literal secret sources in gateway.json");

  const detail = lines.join("; ");
  return {
    name: "secret-sources",
    severity: failed ? "fail" : "pass",
    message: detail,
  };
};
