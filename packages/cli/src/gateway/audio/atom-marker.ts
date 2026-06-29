import * as fs from "node:fs";
import * as path from "node:path";
import { gatewayDir } from "../config";
import { assertSafeSegment } from "../session-store";

export interface AtomMarker {
  threadKey: string; channelId: string; summaryTs: string; uploaderId: string;
  scope: string; title: string; tags: string[]; summaryText: string; at: number;
}

function markerDir(): string { return path.join(gatewayDir(), "audio-atom"); }
function markerPath(channelId: string, summaryTs: string): string {
  assertSafeSegment(channelId, "channelId");
  assertSafeSegment(summaryTs, "summaryTs");
  return path.join(markerDir(), `${channelId}-${summaryTs}.json`);
}

/** Drop any existing markers for this threadKey (retry hygiene), then write. */
export function writeAtomMarker(m: AtomMarker): void {
  deleteMarkersByThreadKey(m.threadKey);
  const file = markerPath(m.channelId, m.summaryTs);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(m));
}

export function readAtomMarker(channelId: string, summaryTs: string): AtomMarker | undefined {
  try { return JSON.parse(fs.readFileSync(markerPath(channelId, summaryTs), "utf8")) as AtomMarker; }
  catch { return undefined; }
}

/** Atomic mutex: rename marker → .saving. Only one caller wins; the rest get undefined. */
export function acquireAtomMarker(channelId: string, summaryTs: string): AtomMarker | undefined {
  const file = markerPath(channelId, summaryTs);
  const saving = `${file}.saving`;
  try { fs.renameSync(file, saving); } catch { return undefined; }
  try { return JSON.parse(fs.readFileSync(saving, "utf8")) as AtomMarker; }
  catch { return undefined; }
}

/** Restore a marker after a failed save: rename .saving → .json so re-react can retry. Best-effort; ignores errors. */
export function restoreAtomMarker(channelId: string, summaryTs: string): void {
  const file = markerPath(channelId, summaryTs);
  const saving = `${file}.saving`;
  try { fs.renameSync(saving, file); } catch { /* best-effort */ }
}

export function deleteAtomMarker(channelId: string, summaryTs: string): void {
  const file = markerPath(channelId, summaryTs);
  try { fs.rmSync(file, { force: true }); } catch { /* noop */ }
  try { fs.rmSync(`${file}.saving`, { force: true }); } catch { /* noop */ }
}

export function deleteMarkersByThreadKey(threadKey: string): void {
  const dir = markerDir();
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir)) {
    if (!e.endsWith(".json")) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, e), "utf8")) as AtomMarker;
      if (m.threadKey === threadKey) fs.rmSync(path.join(dir, e), { force: true });
    } catch { /* skip */ }
  }
}

/** Remove markers (and stray .saving files) older than maxAgeMs. Mirrors sweepStaleAudioClaims. */
export function sweepStaleAtomMarkers(maxAgeMs = 7 * 24 * 3600 * 1000, now: () => number = () => Date.now()): number {
  const dir = markerDir();
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const e of fs.readdirSync(dir)) {
    const file = path.join(dir, e);
    if (e.endsWith(".saving")) { try { fs.rmSync(file, { force: true }); removed++; } catch { /* noop */ } continue; }
    if (!e.endsWith(".json")) continue;
    try {
      const m = JSON.parse(fs.readFileSync(file, "utf8")) as AtomMarker;
      if (now() - m.at > maxAgeMs) { fs.rmSync(file, { force: true }); removed++; }
    } catch { try { fs.rmSync(file, { force: true }); removed++; } catch { /* noop */ } }
  }
  return removed;
}
