import * as fs from "node:fs";
import * as path from "node:path";
import { gatewayDir } from "../config";
import { assertSafeSegment } from "../session-store";

function baseDir(): string {
  return path.join(gatewayDir(), "audio-tmp");
}

export function makeJobTempDir(jobId: string): string {
  assertSafeSegment(jobId, "audioJobId");
  const dir = path.join(baseDir(), jobId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

export function sweepStaleAudioTemp(
  maxAgeMs = 6 * 3600 * 1000,
  now: () => number = () => Date.now(),
): number {
  const base = baseDir();
  if (!fs.existsSync(base)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(base)) {
    const dir = path.join(base, name);
    try {
      if (now() - fs.statSync(dir).mtimeMs > maxAgeMs) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      /* skip */
    }
  }
  return removed;
}
