import * as fs from "node:fs";
import * as path from "node:path";
import { gatewayDir } from "../config";
import { assertSafeSegment } from "../session-store";

/**
 * Returns true (and writes a marker) on the first call for this scopeId
 * so the caller can post a one-time consent notice. Returns false on every
 * subsequent call — the notice was already shown for this scope.
 *
 * scopeId is sanitised to a safe filename segment before use.
 */
export function needsConsentNotice(scopeId: string): boolean {
  const safe = scopeId.replace(/[^A-Za-z0-9_-]/g, "_");
  assertSafeSegment(safe, "audioConsentScope");
  const file = path.join(gatewayDir(), "audio-consent", `${safe}.json`);
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ at: Date.now() }));
  return true;
}
