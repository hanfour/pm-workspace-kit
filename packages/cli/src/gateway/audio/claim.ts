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
