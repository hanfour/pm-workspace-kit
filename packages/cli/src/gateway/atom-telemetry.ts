/**
 * Atom usage telemetry (P2a). Sidecar rollup at
 * `~/.pmk/gateway/atom-telemetry.json` — the authoritative per-atom
 * counter store. Bumps are SYNCHRONOUS on purpose: single-threaded
 * Node runs a sync load-modify-save to completion before any other
 * callback, so concurrent turns can't interleave and lose a count
 * (the same reason the v0.13 channel-log went append-only, solved here
 * by never awaiting mid-write). Writes go through temp-file + rename so
 * a crash can't leave a half-written sidecar. All bumps are
 * failure-isolated: telemetry must never break a turn or a reaction.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { gatewayDir } from "./config";

/**
 * Bounds the dedupe-scan cost of questionedKeys to O(CAP) per bump.
 * Evicting old keys is safe because duplicate questioned-events (Slack
 * retries / re-reactions) only recur within a short window, so
 * long-evicted keys will not reappear in practice.
 * Full pruning / persistence-trim is deferred to P2b.
 */
export const QUESTIONED_KEYS_CAP = 2000;

export interface AtomTelemetryEntry {
  reuseCount: number;
  lastRetrievedAt: string | null;
  questionedCount: number;
  lastQuestionedAt: string | null;
}

export interface AtomTelemetryStore {
  version: 1;
  atoms: Record<string, AtomTelemetryEntry>;
  questionedKeys: string[];
}

function telemetryPath(): string {
  return path.join(gatewayDir(), "atom-telemetry.json");
}

function emptyEntry(): AtomTelemetryEntry {
  return {
    reuseCount: 0,
    lastRetrievedAt: null,
    questionedCount: 0,
    lastQuestionedAt: null,
  };
}

export function loadTelemetry(): AtomTelemetryStore {
  try {
    const raw = fs.readFileSync(telemetryPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AtomTelemetryStore>;
    return {
      version: 1,
      atoms: parsed.atoms ?? {},
      questionedKeys: parsed.questionedKeys ?? [],
    };
  } catch {
    return { version: 1, atoms: {}, questionedKeys: [] };
  }
}

function saveTelemetry(store: AtomTelemetryStore): void {
  const dir = gatewayDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = telemetryPath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

export function bumpReuse(
  atomIds: string[],
  at: string = new Date().toISOString(),
): void {
  if (atomIds.length === 0) return;
  try {
    const store = loadTelemetry();
    const atoms = { ...store.atoms };
    for (const id of atomIds) {
      const e = atoms[id] ?? emptyEntry();
      atoms[id] = { ...e, reuseCount: e.reuseCount + 1, lastRetrievedAt: at };
    }
    saveTelemetry({ ...store, atoms });
  } catch {
    /* telemetry must never break a turn */
  }
}

export function bumpQuestioned(
  atomIds: string[],
  dedupeKey: string,
  at: string = new Date().toISOString(),
): void {
  if (atomIds.length === 0) return;
  try {
    const store = loadTelemetry();
    if (store.questionedKeys.includes(dedupeKey)) return;
    const atoms = { ...store.atoms };
    for (const id of atomIds) {
      const e = atoms[id] ?? emptyEntry();
      atoms[id] = {
        ...e,
        questionedCount: e.questionedCount + 1,
        lastQuestionedAt: at,
      };
    }
    const nextKeys = [...store.questionedKeys, dedupeKey];
    const questionedKeys =
      nextKeys.length > QUESTIONED_KEYS_CAP
        ? nextKeys.slice(nextKeys.length - QUESTIONED_KEYS_CAP)
        : nextKeys;
    saveTelemetry({ ...store, atoms, questionedKeys });
  } catch {
    /* never break a reaction / escalation */
  }
}
