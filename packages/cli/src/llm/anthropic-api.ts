import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, PmkConfig } from "@pmk/shared";
import type { ChatOptions, LlmProvider } from "./provider";

/**
 * Uses a raw Anthropic API key. Requires ANTHROPIC_API_KEY (or config.apiKey).
 */
export class AnthropicApiKeyProvider implements LlmProvider {
  readonly name = "anthropic-api" as const;
  readonly displayName = "Anthropic API (api key)";
  private readonly client: Anthropic;
  private readonly config: PmkConfig;

  constructor(config: PmkConfig & { apiKey: string }) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.config = config;
  }

  async chat(
    systemPrompt: string,
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): Promise<string> {
    const stream = await this.client.messages.stream({
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      system: systemPrompt,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    let full = "";
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        const chunk = event.delta.text;
        full += chunk;
        opts.onToken?.(chunk);
      }
    }
    return full;
  }
}
