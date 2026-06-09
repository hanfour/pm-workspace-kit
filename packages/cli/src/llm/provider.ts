import type { ChatMessage, LlmProviderName } from "@pmk/shared";

export interface ChatOptions {
  onToken?: (chunk: string) => void;
  /**
   * Slack user ID (or "cli:<name>" for CLI invocations) the call is on
   * behalf of. Used by AnthropicApiKeyProvider to attribute the
   * `token.usage` audit event. Optional — providers that don't emit
   * usage events ignore it; if undefined no event is written.
   */
  actor?: string;
}

export interface LlmProvider {
  readonly name: Exclude<LlmProviderName, "auto">;
  readonly displayName: string;
  chat(
    systemPrompt: string,
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): Promise<string>;
  /**
   * Optional vision capability: describe an image to text. Providers that
   * can't do vision (e.g. claude-login) leave this undefined; callers must
   * check `typeof p.describeImage === "function"` and degrade gracefully.
   */
  describeImage?(
    image: { data: Buffer; mimetype: string },
    prompt: string,
    opts?: ChatOptions,
  ): Promise<string>;
}

export class NoProviderAvailableError extends Error {
  constructor(attempted: string[]) {
    super(
      `[pmk] no usable LLM provider found (tried: ${attempted.join(", ")}).\n` +
        "  Try one of:\n" +
        "    • set ANTHROPIC_API_KEY in your environment — https://console.anthropic.com\n" +
        "    • install Claude Code and run `claude login` — https://claude.com/product/claude-code (legacy fallback)\n" +
        "  Or pin a provider with PMK_PROVIDER=<anthropic-api|claude-agent>.",
    );
    this.name = "NoProviderAvailableError";
  }
}
