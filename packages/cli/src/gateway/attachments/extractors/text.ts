import { FILE_EXTRACT_CAP, type ExtractResult } from "../types";

/** Min non-whitespace chars for an extraction to count as content. */
const MIN_CONTENT_CHARS = 20;

export async function extractText(buf: Buffer): Promise<ExtractResult> {
  // Binary sniff: a NUL byte in the first 8KB means it isn't text.
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return { ok: false, reason: "looks binary, not text" };

  const s = buf.toString("utf8");
  if (s.replace(/\s/g, "").length < MIN_CONTENT_CHARS) {
    return { ok: false, reason: "empty content" };
  }
  return { ok: true, text: cap(s) };
}

export function cap(s: string): string {
  if (s.length <= FILE_EXTRACT_CAP) return s;
  return s.slice(0, FILE_EXTRACT_CAP) + "\n…(truncated)";
}
