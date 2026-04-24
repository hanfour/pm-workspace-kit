import type { ChatMessage } from "@pmk/shared";

/**
 * In-memory multi-turn conversation state.
 * Persisted to disk only via `ingest` / session-save commands (M2+).
 */
export class Session {
  private messages: ChatMessage[] = [];

  addUser(text: string): void {
    this.messages.push({ role: "user", content: text });
  }

  addAssistant(text: string): void {
    this.messages.push({ role: "assistant", content: text });
  }

  history(): ChatMessage[] {
    return this.messages.slice();
  }

  last(role: ChatMessage["role"]): string | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === role) return this.messages[i].content;
    }
    return undefined;
  }

  clear(): void {
    this.messages = [];
  }
}
