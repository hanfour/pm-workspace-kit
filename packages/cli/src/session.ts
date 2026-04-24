import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ChatMessage } from "@pmk/shared";

export interface ParkedSession {
  version: 1;
  name: string;
  verb: string;
  systemPromptKey?: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

/** Directory where `pmk park` stores named session snapshots. */
export function parksDir(): string {
  return path.join(os.homedir(), ".pmk", "parks");
}

export function parkPath(name: string): string {
  return path.join(parksDir(), `${name}.json`);
}

export function listParks(): string[] {
  const dir = parksDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

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

  load(messages: ChatMessage[]): void {
    this.messages = messages.slice();
  }

  size(): number {
    return this.messages.length;
  }

  park(name: string, verb: string, systemPromptKey?: string): string {
    const now = new Date().toISOString();
    const payload: ParkedSession = {
      version: 1,
      name,
      verb,
      systemPromptKey,
      createdAt: now,
      updatedAt: now,
      messages: this.messages.slice(),
    };
    const file = parkPath(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
    return file;
  }

  static resumeFromPark(name: string): ParkedSession {
    const file = parkPath(name);
    if (!fs.existsSync(file)) {
      throw new Error(`park not found: ${name} (looked at ${file})`);
    }
    return JSON.parse(fs.readFileSync(file, "utf8")) as ParkedSession;
  }
}
