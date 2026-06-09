import { type ExtractResult } from "../types";
import { cap } from "./text";

/**
 * Extract text from a PDF using unpdf (pure JS, wraps pdf.js). unpdf is
 * ESM-only; the package builds to CJS, so load it via dynamic import().
 */
export async function extractPdf(buf: Buffer): Promise<ExtractResult> {
  let text: string;
  try {
    const unpdf = await import("unpdf");
    const doc = await unpdf.getDocumentProxy(new Uint8Array(buf));
    const out = await unpdf.extractText(doc, { mergePages: true });
    text = Array.isArray(out.text) ? out.text.join("\n") : out.text;
  } catch {
    return { ok: false, reason: "could not parse PDF (encrypted or corrupt?)" };
  }
  if (text.replace(/\s/g, "").length < 20) {
    return { ok: false, reason: "no extractable text (scanned image PDF?)" };
  }
  return { ok: true, text: cap(text) };
}
