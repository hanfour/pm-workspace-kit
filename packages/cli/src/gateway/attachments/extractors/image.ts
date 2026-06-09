import { MAX_IMAGE_BYTES, type ExtractResult } from "../types";
import { cap } from "./text";
import type { LlmProvider } from "../../../llm/provider";

const PROMPT =
  "Describe this image's content for use as reference context; transcribe any text in it verbatim.";

export async function extractImage(
  buf: Buffer,
  mimetype: string,
  ctx: { llm: LlmProvider },
): Promise<ExtractResult> {
  // Anthropic's 5 MB limit is on the base64-encoded payload (~1.33× decoded).
  // Compare against the encoded size so images just under 5 MB decoded but
  // over 5 MB encoded are correctly rejected.
  const base64Bytes = Math.ceil(buf.byteLength / 3) * 4;
  if (base64Bytes > MAX_IMAGE_BYTES) {
    return { ok: false, reason: "image too large (over 5MB)" };
  }
  if (typeof ctx.llm.describeImage !== "function") {
    return { ok: false, reason: "images need the ANTHROPIC_API_KEY provider" };
  }
  let text: string;
  try {
    text = await ctx.llm.describeImage({ data: buf, mimetype }, PROMPT);
  } catch {
    return { ok: false, reason: "vision call failed" };
  }
  if (text.trim().length === 0) return { ok: false, reason: "empty description" };
  return { ok: true, text: cap(text) };
}
