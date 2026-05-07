import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ChatMessage, PmkConfig } from "@pmk/shared";
import type { ChatOptions, LlmProvider } from "./provider";

/**
 * Typed error wrapper for context-window-exhaustion failures coming out
 * of the underlying SDK. The gateway-level retry path uses this to
 * trigger a forced prune without relying on string-matching at a
 * distance.
 */
export class PmkContextTooLongError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super("PmkContextTooLongError");
    this.name = "PmkContextTooLongError";
    this.cause = cause;
  }
}

const CONTEXT_TOO_LONG_RE = /msg_too_long|prompt is too long|context.+exceed/i;

export function isContextTooLongError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return CONTEXT_TOO_LONG_RE.test(err.message);
}

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
    try {
      const prompt = serialiseHistory(messages);

      // Pass our own systemPrompt as a string — this replaces Claude
      // Code's `claude_code` preset entirely, so the model should not
      // think of itself as an agent with tools. `allowedTools: []` is
      // belt-and-braces: even if a tool sneaks in, it can't execute.
      //
      // Note: we previously scoped the main thread to a custom
      // AgentDefinition to suppress user-skill bleed (e.g. superpowers),
      // but that *reinforced* agent/tool framing in the model's mind —
      // responses started announcing "Skill tool → requirement-intake"
      // instead of just answering. Removing the agent wrapper and
      // relying on the systemPrompt + prompt discipline produces cleaner
      // chat turns, at the cost of occasionally seeing a superpowers
      // banner in the opener. Acceptable trade.
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
    } catch (err) {
      if (isContextTooLongError(err)) throw new PmkContextTooLongError(err);
      throw err;
    }
  }
}

function serialiseHistory(messages: ChatMessage[]): string {
  if (messages.length === 1 && messages[0].role === "user") {
    return messages[0].content;
  }
  const lines: string[] = ["=== Conversation so far ==="];
  for (let i = 0; i < messages.length - 1; i++) {
    const m = messages[i];
    lines.push(
      `\n## ${m.role === "user" ? "User" : "Assistant"}\n${m.content}`,
    );
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
