import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ChatMessage, PmkConfig } from "@pmk/shared";
import type { ChatOptions, LlmProvider } from "./provider";

export function buildImageUserMessage(
  image: { data: Buffer; mimetype: string },
  prompt: string,
): SDKUserMessage {
  return {
    type: "user",
    parent_tool_use_id: null,
    message: {
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
  };
}

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
  return err instanceof Error && CONTEXT_TOO_LONG_RE.test(err.message);
}

/** Delegates to the local Claude Code login through the Agent SDK. */
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
      const q = query({
        prompt: serialiseHistory(messages),
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
      return await this.collectText(q, opts);
    } catch (err) {
      if (isContextTooLongError(err)) throw new PmkContextTooLongError(err);
      throw err;
    }
  }

  async describeImage(
    image: { data: Buffer; mimetype: string },
    prompt: string,
    opts: ChatOptions = {},
  ): Promise<string> {
    try {
      const message = buildImageUserMessage(image, prompt);
      async function* once(): AsyncGenerator<SDKUserMessage> {
        yield message;
      }
      const q = query({
        prompt: once(),
        options: {
          model: this.config.model,
          systemPrompt:
            "You describe images concisely for use as reference context; transcribe any text in the image verbatim. No tools.",
          includePartialMessages: true,
          allowedTools: [],
          permissionMode: "default",
          ...(this.executablePath
            ? { pathToClaudeCodeExecutable: this.executablePath }
            : {}),
        },
      });
      return await this.collectText(q, opts);
    } catch (err) {
      if (isContextTooLongError(err)) throw new PmkContextTooLongError(err);
      throw err;
    }
  }

  private async collectText(
    q: ReturnType<typeof query>,
    opts: ChatOptions,
  ): Promise<string> {
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
