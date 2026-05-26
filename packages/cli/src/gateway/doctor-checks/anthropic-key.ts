import type { DoctorCheckResult, DoctorContext } from "../doctor";

export async function anthropicKeyCheck(
  ctx: DoctorContext,
): Promise<DoctorCheckResult> {
  // Env takes precedence over config (matches loadCliConfig() behavior).
  const key = ctx.envAnthropicKey || ctx.config?.apiKey || "";
  if (!key) {
    return {
      name: "anthropic-key",
      severity: "fail",
      message: "no Anthropic API key (env ANTHROPIC_API_KEY nor gateway.json apiKey)",
      hint: "export ANTHROPIC_API_KEY=... or run pmk gateway init",
    };
  }
  const res = await ctx.runners.anthropicEcho(key);
  if (!res.ok) {
    return {
      name: "anthropic-key",
      severity: "fail",
      message: `Anthropic API rejected the key: ${res.error ?? "unknown"}`,
      hint: "verify the key at console.anthropic.com/settings/keys",
    };
  }
  const source = ctx.envAnthropicKey ? "env ANTHROPIC_API_KEY" : "gateway.json apiKey";
  return {
    name: "anthropic-key",
    severity: "pass",
    message: `Anthropic API key accepted (source: ${source})`,
  };
}
