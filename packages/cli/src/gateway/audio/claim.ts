import * as fs from "node:fs";
import * as path from "node:path";
import { gatewayDir } from "../config";
import { assertSafeSegment } from "../session-store";

function claimPath(fileId: string): string {
  assertSafeSegment(fileId, "audioFileId");
  return path.join(gatewayDir(), "audio-claims", `${fileId}.json`);
}

export function claimAudio(fileId: string): boolean {
  const file = claimPath(fileId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, JSON.stringify({ at: Date.now() }), { flag: "wx" });
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false; // already claimed
    throw err;
  }
}

export function releaseAudio(fileId: string): void {
  try {
    fs.rmSync(claimPath(fileId), { force: true });
  } catch {
    /* noop */
  }
}

export function finalizeAudio(fileId: string): void {
  assertSafeSegment(fileId, "audioFileId"); // validate at boundary
  /* keep the claim so redelivery is a no-op; left explicit for symmetry */
}

/**
 * Remove audio claim files older than `maxAgeMs` (checked against the
 * claim's `at` timestamp). Mirrors `sweepStaleAudioTemp` in temp.ts.
 * Returns the number of claims removed.
 */
export function sweepStaleAudioClaims(
  maxAgeMs = 24 * 3600 * 1000,
  now: () => number = () => Date.now(),
): number {
  const dir = path.join(gatewayDir(), "audio-claims");
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const file = path.join(dir, entry);
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as { at: number };
      if (now() - data.at > maxAgeMs) {
        fs.rmSync(file, { force: true });
        removed++;
      }
    } catch {
      // Unparseable or unreadable claim — remove to unblock retries.
      try {
        fs.rmSync(file, { force: true });
        removed++;
      } catch {
        /* noop */
      }
    }
  }
  return removed;
}
