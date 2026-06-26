import { runMedia } from "./spawn";

export async function probeAudio(
  filePath: string,
  deps: { run?: typeof runMedia } = {},
): Promise<{ durationSec: number; sizeBytes: number }> {
  const run = deps.run ?? runMedia;
  const { stdout } = await run(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration,size", "-of", "json", "--", filePath],
    { timeoutMs: 30_000 },
  );
  let parsed: { format?: { duration?: string; size?: string } };
  try { parsed = JSON.parse(stdout); } catch { throw new Error("ffprobe: unparseable output"); }
  const durationSec = Number(parsed.format?.duration);
  const sizeBytes = Number(parsed.format?.size);
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("ffprobe: no duration");
  return { durationSec, sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0 };
}
