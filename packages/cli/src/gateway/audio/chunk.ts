import * as fs from "node:fs";
import * as path from "node:path";
import { runMedia } from "./spawn";
import { probeAudio } from "./probe";
import { AUDIO_REQUEST_MAX_BYTES, AUDIO_CHUNK_TARGET_BYTES } from "../attachments/types";

export interface ChunkDeps {
  run?: typeof runMedia;
  probe?: typeof probeAudio;
  statSize?: (p: string) => number;
  listChunks?: (dir: string) => string[];
  signal?: AbortSignal;
}

const encodeArgs = (input: string, output: string): string[] => [
  "-v", "error", "-y", "-i", input,
  "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "16k",
  "--", output,
];

export async function prepareChunks(inputPath: string, outDir: string, deps: ChunkDeps = {}): Promise<string[]> {
  const run = deps.run ?? runMedia;
  const probe = deps.probe ?? probeAudio;
  const statSize = deps.statSize ?? ((p: string) => fs.statSync(p).size);
  const listChunks = deps.listChunks ?? ((dir: string) =>
    fs.readdirSync(dir)
      .filter((f) => /^chunk-\d{3}\.ogg$/.test(f))
      .sort()
      .map((f) => path.join(dir, f))
  );

  // SECURITY: input passed positionally after "--"; output is a controlled template, never derived from Slack filename.
  const encoded = path.join(outDir, "encoded.ogg");
  await run("ffmpeg", encodeArgs(inputPath, encoded), { timeoutMs: 30 * 60_000, signal: deps.signal });

  const encodedSize = statSize(encoded);
  if (encodedSize <= AUDIO_REQUEST_MAX_BYTES) return [encoded];

  const { durationSec } = await probe(encoded, { run });
  const segSec = Math.max(60, Math.floor((durationSec * AUDIO_CHUNK_TARGET_BYTES) / encodedSize));

  // SECURITY: output path is a controlled template; input is the already-controlled encoded.ogg path.
  await run(
    "ffmpeg",
    [
      "-v", "error", "-y", "-i", encoded,
      "-f", "segment", "-segment_time", String(segSec),
      "-c", "copy",
      "--", path.join(outDir, "chunk-%03d.ogg"),
    ],
    { timeoutMs: 30 * 60_000, signal: deps.signal },
  );

  const chunks = listChunks(outDir);
  return chunks.length > 0 ? chunks : [encoded];
}
