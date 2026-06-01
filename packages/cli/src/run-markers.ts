/**
 * Adoption run markers (P4). A single file `~/.pmk/adoption.json` records
 * the first-ever `pmk` run and the first PRD written, so the adoption
 * report can compute time-to-first-PRD. Writes are SYNCHRONOUS,
 * write-if-absent (never overwrite a set marker), crash-safe (temp +
 * rename), and FAILURE-ISOLATED — a marker write must never break a CLI
 * invocation or a propose run.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface AdoptionMarkers {
  firstRunAt: string | null;
  firstPrdAt: string | null;
  /**
   * True when firstRunAt was set on an install that already had pmk
   * state — so firstRunAt is "first run after upgrade", not first-ever
   * adoption. The report shows time-to-first-PRD as n/a in that case.
   */
  preExisting: boolean;
}

function pmkDir(): string {
  return path.join(os.homedir(), ".pmk");
}

function markersPath(): string {
  return path.join(pmkDir(), "adoption.json");
}

export function readMarkers(): AdoptionMarkers {
  try {
    const raw = fs.readFileSync(markersPath(), "utf8");
    const p = JSON.parse(raw) as Partial<AdoptionMarkers>;
    return {
      firstRunAt: p.firstRunAt ?? null,
      firstPrdAt: p.firstPrdAt ?? null,
      preExisting: p.preExisting ?? false,
    };
  } catch {
    return { firstRunAt: null, firstPrdAt: null, preExisting: false };
  }
}

function writeMarkers(m: AdoptionMarkers): void {
  const dir = pmkDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = markersPath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

/** Does ~/.pmk already hold pmk state (so this isn't a fresh install)? */
function pmkHasPriorState(): boolean {
  const candidates = [
    path.join(pmkDir(), "gateway.json"),
    path.join(pmkDir(), "knowledge"),
    path.join(pmkDir(), "gateway"),
  ];
  return candidates.some((p) => fs.existsSync(p));
}

export function recordFirstRun(at: string = new Date().toISOString()): void {
  try {
    const m = readMarkers();
    if (m.firstRunAt) return;
    writeMarkers({ ...m, firstRunAt: at, preExisting: pmkHasPriorState() });
  } catch {
    /* never break the CLI */
  }
}

export function recordFirstPrd(at: string = new Date().toISOString()): void {
  try {
    const m = readMarkers();
    if (m.firstPrdAt) return;
    writeMarkers({ ...m, firstPrdAt: at });
  } catch {
    /* never break a propose run */
  }
}
