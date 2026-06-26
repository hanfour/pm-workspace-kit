import type { LlmProvider } from "../../llm/provider";
import {
  MAX_FILE_BYTES, MAX_FILES_PER_MESSAGE, INGEST_PHASE_TIMEOUT_MS,
  type ExtractResult, type FileStatus, type SlackFile, type ThreadKey,
} from "./types";
import { categoryFor } from "./registry";
import { fetchSlackFile } from "./download";
import { extractText } from "./extractors/text";
import { extractPdf } from "./extractors/pdf";
import { extractImage } from "./extractors/image";
import { appendAttachment, hasAttachment } from "./store";
import { assertSafeSegment } from "../session-store";

export interface IngestArgs {
  files: SlackFile[];
  threadKey: ThreadKey;
  botToken: string;
  llm: LlmProvider;
  download?: (file: SlackFile, token: string) => Promise<Buffer>;
  extractText?: (buf: Buffer) => Promise<ExtractResult>;
  extractPdf?: (buf: Buffer) => Promise<ExtractResult>;
  extractImage?: (buf: Buffer, mimetype: string, ctx: { llm: LlmProvider }) => Promise<ExtractResult>;
  now?: () => number;    // timestamp for the stored `at`
  clock?: () => number;  // wall-clock for the phase deadline (default Date.now)
}

export async function ingestAttachments(args: IngestArgs): Promise<FileStatus[]> {
  const download = args.download ?? fetchSlackFile;
  const exText = args.extractText ?? extractText;
  const exPdf = args.extractPdf ?? extractPdf;
  const exImg = args.extractImage ?? extractImage;
  const now = args.now ?? (() => Date.now());
  const clock = args.clock ?? (() => Date.now());

  const files = args.files.slice(0, MAX_FILES_PER_MESSAGE);
  const out: FileStatus[] = [];

  // Report files beyond the cap as skipped so summarize() surfaces them.
  for (const dropped of args.files.slice(MAX_FILES_PER_MESSAGE)) {
    const droppedName = (dropped.name ?? dropped.id).slice(0, 255);
    out.push({
      fileId: dropped.id,
      name: droppedName,
      status: "skipped",
      reason: "只讀前 10 個檔案,其餘請另開訊息重傳",
    });
  }

  // Capture the start time once. Per-file checks use a fresh clock() call so
  // that a slow file's wall time counts against the budget.
  const phaseStart = clock();
  const deadline = phaseStart + INGEST_PHASE_TIMEOUT_MS;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const name = (file.name ?? file.id).slice(0, 255);

    const skip = (reason: string): void => {
      out.push({ fileId: file.id, name, status: "skipped", reason });
    };

    // Phase timeout: check BEFORE processing file i > 0 (file 0 always starts).
    // This means: if file i-1 pushed us past the deadline, skip i..end.
    if (i > 0 && clock() > deadline) {
      skip("ingestion timed out");
      continue;
    }

    // Validate file.id before any path-derived operation (appendAttachment
    // calls assertSafeSegment which throws; catch it here so a forged id
    // skips only this file instead of aborting the whole batch).
    try {
      assertSafeSegment(file.id, "fileId");
    } catch {
      skip("invalid file id (unsafe path segment)");
      continue;
    }

    if (hasAttachment(args.threadKey, file.id)) {
      out.push({ fileId: file.id, name, status: "ok" });
      continue;
    }

    const cat = categoryFor(file);
    if (cat === "unsupported") {
      skip("unsupported type (text/markdown/code, PDF, PNG/JPEG/GIF/WebP only)");
      continue;
    }
    if (cat === "audio") {
      skip("音訊請在已啟用音訊功能的 DM 或頻道直接上傳(此處不作文字處理)");
      continue;
    }

    if (file.is_external) {
      skip("can't read linked (Google/Box) files");
      continue;
    }

    if (!file.url_private_download && !file.url_private) {
      skip("file URL not available; re-upload");
      continue;
    }

    if ((file.size ?? 0) > MAX_FILE_BYTES) {
      skip("exceeds the 10MB limit");
      continue;
    }

    let buf: Buffer;
    try {
      buf = await download(file, args.botToken);
    } catch (err) {
      // Strip anything that looks like a URL or token from the error message
      const raw = (err as Error).message ?? "download failed";
      const sanitized = raw
        .replace(/https?:\/\/\S+/gi, "[url]")
        .replace(/xox[bpas]-[A-Za-z0-9-]+/g, "[token]")
        .replace(/^download failed for \S+ ?/, "");
      skip(sanitized || "download failed");
      continue;
    }

    let res: ExtractResult;
    if (cat === "pdf") {
      res = await exPdf(buf);
    } else if (cat === "image") {
      res = await exImg(buf, file.mimetype ?? "", { llm: args.llm });
    } else {
      res = await exText(buf);
    }

    if (!res.ok) {
      skip(res.reason);
      continue;
    }

    appendAttachment(args.threadKey, {
      fileId: file.id,
      name,
      mimetype: file.mimetype ?? cat,
      text: res.text,
      at: now(),
    });
    out.push({ fileId: file.id, name, status: "ok" });
  }

  return out;
}

/** Compact one-line summary for the Slack reply (read vs skipped). */
export function summarize(statuses: FileStatus[]): string {
  const ok = statuses.filter((s) => s.status === "ok").map((s) => s.name);
  const skipped = statuses.filter(
    (s): s is Extract<FileStatus, { status: "skipped" }> => s.status === "skipped",
  );
  const parts: string[] = [];
  if (ok.length) parts.push(`已讀:${ok.join(", ")}`);
  if (skipped.length) parts.push(`略過:${skipped.map((s) => `${s.name}(${s.reason})`).join(", ")}`);
  return parts.length ? `_${parts.join(" · ")}_` : "";
}
