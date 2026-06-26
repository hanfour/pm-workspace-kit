import * as fs from "node:fs";
import * as path from "node:path";
import { redactSecrets } from "./redact";

export class TranscribeError extends Error {
  status?: number;
  constructor(message: string, status?: number) { super(redactSecrets(message)); this.name = "TranscribeError"; this.status = status; }
}

const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";

export async function transcribeFile(
  filePath: string,
  opts: { apiKey: string; model: string; language?: string },
  deps: { fetchImpl?: typeof fetch; readStream?: (p: string) => unknown; signal?: AbortSignal } = {},
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const bytes = deps.readStream ? deps.readStream(filePath) : fs.readFileSync(filePath);
  const form = new FormData();
  form.append("model", opts.model);
  if (opts.language) form.append("language", opts.language);
  form.append("file", new Blob([bytes as never]), path.basename(filePath));

  let resp: Response;
  try {
    resp = await fetchImpl(ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${opts.apiKey}` }, body: form as never, signal: deps.signal });
  } catch (err) {
    throw new TranscribeError(`network error: ${(err as Error).message}`);
  }
  if (!resp.ok) {
    let detail = "";
    try { detail = JSON.stringify(await resp.json()); } catch { /* ignore */ }
    throw new TranscribeError(`OpenAI transcribe ${resp.status}: ${detail}`, resp.status);
  }
  const data = (await resp.json()) as { text?: string };
  return data.text ?? "";
}
