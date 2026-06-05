import type { DoctorCheckResult, DoctorContext } from "../doctor";
import { resolveGatewayApiKey } from "../config";

const NAME = "llm-provider";

// LLM provider pre-flight (FR2 #4).
//
// v0.16 fix: this check used to test only a raw Anthropic API key and
// FAIL when none was set — but `resolveProvider` falls back to the
// local `claude` login (claude-agent SDK / OAuth) when no key is
// present. A FAIL there is a false negative that would block a
// perfectly valid OAuth-only host. The check now mirrors the runtime's
// provider resolution exactly.
export async function anthropicKeyCheck(
  ctx: DoctorContext,
): Promise<DoctorCheckResult> {
  // Env takes precedence over config (matches loadConfig() behavior).
  // resolveGatewayApiKey: non-empty env key wins; else resolve the gateway
  // SecretSource (which may be a literal, {env}, or {cmd}).
  const { value: resolvedGatewayKey } = resolveGatewayApiKey(
    undefined,
    ctx.config?.apiKey,
  );
  const key = ctx.envAnthropicKey || resolvedGatewayKey || "";
  const provider = ctx.llmProvider || "auto";

  // Explicit anthropic-api: a key is mandatory and must verify.
  if (provider === "anthropic-api") {
    if (!key) {
      return {
        name: NAME,
        severity: "fail",
        message: "provider=anthropic-api but no API key (env ANTHROPIC_API_KEY nor gateway.json apiKey)",
        hint: "export ANTHROPIC_API_KEY=…, or set provider=auto to use the local claude login",
      };
    }
    return verifyKey(ctx, key);
  }

  // Explicit claude-agent: the key is irrelevant; we need `claude`.
  if (provider === "claude-agent") {
    const cli = await ctx.runners.claudeCli();
    if (!cli.available) {
      return {
        name: NAME,
        severity: "fail",
        message: "provider=claude-agent but `claude` is not on PATH",
        hint: "install Claude Code, or set provider=anthropic-api with an API key",
      };
    }
    return {
      name: NAME,
      severity: "pass",
      message: `LLM via local claude login (claude-agent SDK)${cli.path ? ` at ${cli.path}` : ""}`,
    };
  }

  // auto (default): a key wins; otherwise fall back to the local
  // claude login; otherwise no provider is available.
  if (key) {
    return verifyKey(ctx, key);
  }
  const cli = await ctx.runners.claudeCli();
  if (cli.available) {
    return {
      name: NAME,
      severity: "pass",
      message: `no API key set — will use local claude login (claude-agent SDK)${cli.path ? ` at ${cli.path}` : ""}`,
    };
  }
  return {
    name: NAME,
    severity: "fail",
    message: "no LLM provider: no API key set and `claude` is not on PATH",
    hint: "export ANTHROPIC_API_KEY=… (or run pmk gateway init), or install Claude Code for the OAuth path",
  };
}

async function verifyKey(
  ctx: DoctorContext,
  key: string,
): Promise<DoctorCheckResult> {
  const res = await ctx.runners.anthropicEcho(key);
  if (!res.ok) {
    return {
      name: NAME,
      severity: "fail",
      message: `Anthropic API rejected the key: ${res.error ?? "unknown"}`,
      hint: "verify the key at console.anthropic.com/settings/keys",
    };
  }
  const source = ctx.envAnthropicKey ? "env ANTHROPIC_API_KEY" : "gateway.json apiKey";
  return {
    name: NAME,
    severity: "pass",
    message: `Anthropic API key accepted (source: ${source})`,
  };
}
