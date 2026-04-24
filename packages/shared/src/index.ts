/**
 * @pmk/shared — types and constants used by multiple packages.
 */

export const DOC_TYPES = [
  "PRD",
  "SPEC",
  "PLAN",
  "ADR",
  "REQ",
  "HANDOFF",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export type DocStatus = "Draft" | "In Review" | "Approved" | "Deprecated";

export interface DocFrontMatter {
  doc_id: string;
  title: string;
  owner: string;
  status: DocStatus;
  date: string;
  related?: {
    requirement?: string[];
    plan?: string[];
    spec?: string[];
    prd?: string[];
    architecture?: string[];
    adr?: string[];
    module?: string[];
    confluence_page_id?: string | null;
  };
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * `auto` runs the resolver (prefers a local AI-tool OAuth, then API keys).
 * Named values force a specific provider.
 */
export type LlmProviderName = "auto" | "claude-agent" | "anthropic-api";

export interface PmkConfig {
  apiKey?: string;
  model: string;
  maxTokens: number;
  language: "en" | "zh-TW";
  docsRoot: string;
  provider: LlmProviderName;
}

export const DEFAULT_CONFIG: PmkConfig = {
  model: "claude-sonnet-4-6",
  maxTokens: 4096,
  language: "en",
  docsRoot: "apps/docs/docs",
  provider: "auto",
};
