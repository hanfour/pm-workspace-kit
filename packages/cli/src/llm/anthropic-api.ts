import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, PmkConfig } from "@pmk/shared";
import type { ChatOptions, LlmProvider } from "./provider";
import { appendGatewayEvent } from "../gateway/events";

/**
 * Uses a raw Anthropic API key. Requires ANTHROPIC_API_KEY (or config.apiKey).
 *
 * v0.12.0+: when ChatOptions.actor is provided, emits a `token.usage`
 * audit event after each successful stream completion. Best-effort —
 * audit-event failures don't surface as chat errors.
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

    // v0.12.0: emit token.usage audit event for the call. Only fires
    // when caller provided an actor (Slack user ID or "cli:<name>").
    // Best-effort — failures here must not break the chat() return.
    if (opts.actor) {
      try {
        const final = await stream.finalMessage();
        // The pinned SDK's `Usage` type only declares input/output_tokens;
        // newer Anthropic API responses also surface cache_*_input_tokens
        // at runtime. Widen here so we can record them when present.
        const usage = final.usage as typeof final.usage & {
          cache_read_input_tokens?: number | null;
          cache_creation_input_tokens?: number | null;
        };
        appendGatewayEvent({
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
        // Swallow — audit-event failures shouldn't surface as chat errors.
      }
    }

    return full;
  }
}
