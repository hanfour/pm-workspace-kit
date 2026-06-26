import { IMAGE_MIMETYPES, AUDIO_MIMETYPES, AUDIO_FILETYPES } from "./types";

export type Category = "text" | "pdf" | "image" | "audio" | "unsupported";

const TEXT_FILETYPES = new Set([
  "markdown", "text", "javascript", "typescript", "python", "ruby", "go",
  "rust", "java", "c", "cpp", "csharp", "php", "shell", "yaml", "json",
  "html", "css", "sql", "xml", "tsx", "jsx",
]);

/** Classify a Slack file into an extractor category by mimetype, then filetype. */
export function categoryFor(file: { mimetype?: string; filetype?: string }): Category {
  const mt = (file.mimetype ?? "").toLowerCase();
  if (mt === "application/pdf") return "pdf";
  if (IMAGE_MIMETYPES.has(mt)) return "image";
  if (AUDIO_MIMETYPES.has(mt)) return "audio";
  if (mt.startsWith("text/") || mt === "application/json") return "text";
  if (file.filetype && AUDIO_FILETYPES.has(file.filetype.toLowerCase())) return "audio";
  if (file.filetype && TEXT_FILETYPES.has(file.filetype.toLowerCase())) return "text";
  return "unsupported";
}
