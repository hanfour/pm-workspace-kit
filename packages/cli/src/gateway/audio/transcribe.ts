import * as os from "node:os";
import { probeAudio } from "./probe";
import { prepareChunks } from "./chunk";
import { transcribeFile, TranscribeError } from "./transcribe-client";
import { MAX_AUDIO_DURATION_SEC, TRANSCRIPT_CAP } from "../attachments/types";

export type TranscribeResult =
  | { ok: true; transcript: string; durationSec: number; chunks: number }
  | { ok: false; reason: "too-long" | "transcribe-failed"; durationSec?: number; partialTranscript?: string; failedSegment?: number; detail?: string };

export interface TranscribeDeps {
  probe?: typeof probeAudio;
  prepare?: (input: string, outDir: string, d?: unknown) => Promise<string[]>;
  transcribeFile?: typeof transcribeFile;
  sleep?: (ms: number) => Promise<void>;
  outDir?: string;
  signal?: AbortSignal;
  /** Skip the internal probe() call and use this duration directly. */
  knownDurationSec?: number;
}

const truncate = (s: string): string =>
  s.length <= TRANSCRIPT_CAP ? s : s.slice(0, TRANSCRIPT_CAP) + "\n…(truncated)";

async function withRetry(
  fn: () => Promise<string>,
  sleep: (ms: number) => Promise<void>,
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof TranscribeError)) throw err;
      lastErr = err;
      const status = err instanceof TranscribeError ? err.status : undefined;
      // Terminal: 4xx errors OTHER than 429 (e.g. 400 Bad Request, 401 Unauthorized)
      // Retryable: 429 (rate-limit), any 5xx (transient server error), network errors (no status)
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) throw err;
      // Exponential backoff before next attempt — only when another attempt will follow.
      if (attempt < 2) await sleep(500 * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

export async function transcribeAudio(
  inputPath: string,
  cfg: { apiKey: string; model: string; language: string; maxDurationSec: number },
  deps: TranscribeDeps = {},
): Promise<TranscribeResult> {
  const probe = deps.probe ?? probeAudio;
  const prepare = deps.prepare ?? (prepareChunks as (i: string, o: string, d?: unknown) => Promise<string[]>);
  const tf = deps.transcribeFile ?? transcribeFile;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const outDir = deps.outDir ?? os.tmpdir();

  const { durationSec } =
    deps.knownDurationSec !== undefined
      ? { durationSec: deps.knownDurationSec }
      : await probe(inputPath, {});
  const maxAllowed = Math.min(cfg.maxDurationSec, MAX_AUDIO_DURATION_SEC);
  if (durationSec > maxAllowed) {
    return { ok: false, reason: "too-long", durationSec };
  }

  const chunks = await prepare(inputPath, outDir, { signal: deps.signal });
  const segs: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    try {
      const text = await withRetry(
        () => tf(chunks[i], { apiKey: cfg.apiKey, model: cfg.model, language: cfg.language }, { signal: deps.signal }),
        sleep,
      );
      segs.push(text);
    } catch (err) {
      if (!(err instanceof TranscribeError)) throw err;
      // Only surface a partialTranscript when at least one segment actually
      // succeeded. A gap-marker-only "partial" (no real content) incurs zero
      // API cost — the caller relies on its absence to refund the quota.
      const hasContent = segs.length > 0;
      const partial = hasContent
        ? truncate(segs.join("\n") + `\n[第 ${i + 1} 段轉錄失敗，回 retry 重跑此段]`)
        : undefined;
      const detail = `${err.status ?? ""} ${err.message}`.trim().slice(0, 200);
      return {
        ok: false,
        reason: "transcribe-failed",
        durationSec,
        partialTranscript: partial,
        failedSegment: i,
        detail,
      };
    }
  }

  return { ok: true, transcript: truncate(segs.join("\n")), durationSec, chunks: chunks.length };
}
