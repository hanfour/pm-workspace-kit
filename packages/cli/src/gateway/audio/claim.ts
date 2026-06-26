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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, JSON.stringify({ at: Date.now() }), { flag: "wx" });
    return true;
  } catch {
    return false; // EEXIST → already claimed
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
  /* keep the claim so redelivery is a no-op; left explicit for symmetry */
}
