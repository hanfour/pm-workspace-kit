import type { LlmProvider } from "../../llm/provider";

/** Subset of the Slack file object the pipeline reads. Defined ONCE here. */
export interface SlackFile {
  id: string;
  name?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
  is_external?: boolean;
}

/** Per-thread storage key (flat-mapped to a path by attachmentLogPath). */
export type ThreadKey =
  | { kind: "dm"; userId: string; threadTs: string }
  | { kind: "channel"; channelId: string; threadTs: string };

/** A stored, extracted attachment (the ONLY shape persisted to JSONL). */
export interface ExtractedAttachment {
  fileId: string;
  name: string;
  mimetype: string;
  text: string;
  at: number;
}

export type ExtractResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/** An extractor turns raw bytes into canonical text. */
export interface AttachmentExtractor {
  extract(buf: Buffer, ctx: { llm: LlmProvider }): Promise<ExtractResult>;
}

/** Per-file outcome surfaced in the ingest summary. */
export type FileStatus =
  | { fileId: string; name: string; status: "ok" }
  | { fileId: string; name: string; status: "skipped"; reason: string };

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 10;
export const FILE_EXTRACT_CAP = 30_000;
export const MAX_ATTACHMENT_CONTEXT_CHARS = 30_000;
export const MIN_ATTACHMENT_CONTEXT_CHARS = 4_000;
export const INGEST_PHASE_TIMEOUT_MS = 60_000;

/** Supported image mimetypes (Claude vision formats). */
export const IMAGE_MIMETYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
