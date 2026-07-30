import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, PmkConfig } from "@pmk/shared";
import type { ChatOptions, LlmProvider, TokenUsageReporter } from "./provider";

/** Uses a raw Anthropic API key. */
export class AnthropicApiKeyProvider implements LlmProvider {
  readonly name = "anthropic-api" as const;
  readonly displayName = "Anthropic API (api key)";
  private readonly client: Anthropic;
  private readonly config: PmkConfig;
  private readonly onUsage?: TokenUsageReporter;

  constructor(
    config: PmkConfig & { apiKey: string },
    onUsage?: TokenUsageReporter,
  ) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.config = config;
    this.onUsage = onUsage;
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

    if (opts.actor && this.onUsage) {
      try {
        const final = await stream.finalMessage();
        const usage = final.usage as typeof final.usage & {
          cache_read_input_tokens?: number | null;
          cache_creation_input_tokens?: number | null;
        };
        this.onUsage({
          type: "token.usage",
          actor: opts.actor,
          provider: "anthropic-api",
          model: this.config.model,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          ...(usage.cache_read_input_tokens !== undefined &&
          usage.cache_read_input_tokens !== null
            ? { cacheReadTokens: usage.cache_read_input_tokens }
            : {}),
          ...(usage.cache_creation_input_tokens !== undefined &&
          usage.cache_creation_input_tokens !== null
            ? { cacheCreationTokens: usage.cache_creation_input_tokens }
            : {}),
        });
      } catch {
        // Usage reporting must never turn a completed chat into an error.
      }
    }

    return full;
  }

  async describeImage(
    image: { data: Buffer; mimetype: string },
    prompt: string,
  ): Promise<string> {
    const res = await this.client.messages.create({
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: image.mimetype as
                  | "image/png"
                  | "image/jpeg"
                  | "image/gif"
                  | "image/webp",
                data: image.data.toString("base64"),
              },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    });
    return res.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n");
  }
}
