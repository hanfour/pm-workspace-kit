import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ChatMessage, PmkConfig } from "@pmk/shared";
import type { ChatOptions, LlmProvider } from "./provider";

/**
 * Delegates to the local `claude` CLI via the Claude Agent SDK, so we
 * inherit whatever auth the user already has (OAuth, subscription, API
 * key, Bedrock, Vertex) without requiring a separate ANTHROPIC_API_KEY.
 *
 * The SDK is stateful per `query()` call. To keep `LlmProvider.chat`
 * stateless from the caller's perspective, each turn serialises the full
 * history into a single prompt wrapped with transcript markers. This is
 * slightly wasteful but keeps the caller interface identical to
 * `AnthropicApiKeyProvider`.
 */
export class ClaudeAgentSdkProvider implements LlmProvider {
  readonly name = "claude-agent" as const;
  readonly displayName = "Claude Agent SDK (local claude login)";
  private readonly config: PmkConfig;
  private readonly executablePath?: string;

  constructor(config: PmkConfig, executablePath?: string) {
    this.config = config;
    this.executablePath = executablePath;
  }

  async chat(
    systemPrompt: string,
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): Promise<string> {
    const prompt = serialiseHistory(messages);

    const q = query({
      prompt,
      options: {
        model: this.config.model,
        systemPrompt,
        includePartialMessages: true,
        allowedTools: [],
        permissionMode: "default",
        ...(this.executablePath
          ? { pathToClaudeCodeExecutable: this.executablePath }
          : {}),
      },
    });

    let full = "";
    for await (const msg of q) {
      if (msg.type === "stream_event") {
        const event = msg.event;
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          const chunk = event.delta.text;
          full += chunk;
          opts.onToken?.(chunk);
        }
      } else if (msg.type === "result") {
        if (msg.subtype !== "success") {
          throw new Error(
            `[pmk] claude-agent returned non-success: ${msg.subtype}`,
          );
        }
        break;
      }
    }
    return full;
  }
}

function serialiseHistory(messages: ChatMessage[]): string {
  if (messages.length === 1 && messages[0].role === "user") {
    return messages[0].content;
  }
  const lines: string[] = ["=== Conversation so far ==="];
  for (let i = 0; i < messages.length - 1; i++) {
    const m = messages[i];
    lines.push(`\n## ${m.role === "user" ? "User" : "Assistant"}\n${m.content}`);
  }
  const latest = messages[messages.length - 1];
  lines.push("\n=== Current turn ===\n");
  lines.push(
    latest.role === "user"
      ? latest.content
      : `[assistant pre-seed]\n${latest.content}`,
  );
  return lines.join("\n");
}
