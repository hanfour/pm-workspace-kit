import * as os from "node:os";
import { probeAudio } from "./probe";
import { prepareChunks } from "./chunk";
import { transcribeFile, TranscribeError } from "./transcribe-client";
import { MAX_AUDIO_DURATION_SEC, TRANSCRIPT_CAP } from "../attachments/types";

export type TranscribeResult =
  | { ok: true; transcript: string; durationSec: number; chunks: number }
  | { ok: false; reason: "too-long" | "transcribe-failed"; durationSec?: number; partialTranscript?: string; failedSegment?: number };

export interface TranscribeDeps {
  probe?: typeof probeAudio;
  prepare?: (input: string, outDir: string, d?: unknown) => Promise<string[]>;
  transcribeFile?: typeof transcribeFile;
  sleep?: (ms: number) => Promise<void>;
  outDir?: string;
  signal?: AbortSignal;
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
      lastErr = err;
      const status = err instanceof TranscribeError ? err.status : undefined;
      // Any HTTP status error other than 429 is terminal — do not retry
      // Only retry 429 (rate-limit) and pure network errors (no status)
      if (status !== undefined && status !== 429) {
        throw err;
      }
      // 429 or network errors (no status): exponential backoff
      await sleep(500 * Math.pow(2, attempt));
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

  const { durationSec } = await probe(inputPath, {});
  const maxAllowed = Math.min(cfg.maxDurationSec, MAX_AUDIO_DURATION_SEC);
  if (durationSec > maxAllowed) {
    return { ok: false, reason: "too-long", durationSec };
  }

  const chunks = await prepare(inputPath, outDir, { signal: deps.signal });
  const segs: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    try {
      const text = await withRetry(
        () => tf(chunks[i], { apiKey: cfg.apiKey, model: cfg.model, language: cfg.language }),
        sleep,
      );
      segs.push(text);
    } catch {
      const partial =
        (segs.length > 0 ? segs.join("\n") + "\n" : "") +
        `[第 ${i + 1} 段轉錄失敗，回 retry 重跑此段]`;
      return {
        ok: false,
        reason: "transcribe-failed",
        durationSec,
        partialTranscript: truncate(partial),
        failedSegment: i,
      };
    }
  }

  return { ok: true, transcript: truncate(segs.join("\n")), durationSec, chunks: chunks.length };
}
