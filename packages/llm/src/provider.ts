import type { ChatMessage, LlmProviderName } from "@pmk/shared";

export interface ChatOptions {
  onToken?: (chunk: string) => void;
  /** Identifies a caller for an optional host-provided usage reporter. */
  actor?: string;
}

export interface TokenUsageEvent {
  type: "token.usage";
  actor: string;
  provider: "anthropic-api";
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export type TokenUsageReporter = (event: TokenUsageEvent) => void;

export interface LlmProvider {
  readonly name: Exclude<LlmProviderName, "auto">;
  readonly displayName: string;
  chat(
    systemPrompt: string,
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): Promise<string>;
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
