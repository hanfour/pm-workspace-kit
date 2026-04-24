import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, PmkConfig } from "@pmk/shared";

/**
 * Thin wrapper around the Anthropic SDK. Streams tokens to stdout
 * and returns the full assistant response.
 */
export class LlmClient {
  private client: Anthropic;
  private config: PmkConfig;

  constructor(config: PmkConfig) {
    if (!config.apiKey) throw new Error("apiKey is required");
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.config = config;
  }

  async chat(
    systemPrompt: string,
    messages: ChatMessage[],
    opts: { onToken?: (chunk: string) => void } = {},
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
