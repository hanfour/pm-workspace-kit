import { IMAGE_MIMETYPES, AUDIO_MIMETYPES, AUDIO_FILETYPES, AUDIO_EXTENSIONS } from "./types";

export type Category = "text" | "pdf" | "image" | "audio" | "unsupported";

const TEXT_FILETYPES = new Set([
  "markdown", "text", "javascript", "typescript", "python", "ruby", "go",
  "rust", "java", "c", "cpp", "csharp", "php", "shell", "yaml", "json",
  "html", "css", "sql", "xml", "tsx", "jsx",
]);

/** Lowercase filename extension (no dot), or "" if none. */
function extOf(name?: string): string {
  if (!name) return "";
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Classify a Slack file into an extractor category by mimetype, then filetype, then filename extension. */
export function categoryFor(file: { mimetype?: string; filetype?: string; name?: string }): Category {
  const mt = (file.mimetype ?? "").toLowerCase();
  if (mt === "application/pdf") return "pdf";
  if (IMAGE_MIMETYPES.has(mt)) return "image";
  if (AUDIO_MIMETYPES.has(mt)) return "audio";
  if (mt.startsWith("text/") || mt === "application/json") return "text";
  if (file.filetype && AUDIO_FILETYPES.has(file.filetype.toLowerCase())) return "audio";
  if (file.filetype && TEXT_FILETYPES.has(file.filetype.toLowerCase())) return "text";
  // Fallback: Slack sometimes omits/uses an unexpected mimetype+filetype
  // (e.g. voice memos). Recognize audio by filename extension so a file like
  // "新錄音.m4a" still routes to transcription.
  if (AUDIO_EXTENSIONS.has(extOf(file.name))) return "audio";
  return "unsupported";
}
