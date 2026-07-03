import type { ReviewStrategy } from "../../adapters/mra";

export type Phase = "prepare" | "pkb" | "analyze" | "posting" | "done";

const PHASE_FLOOR: Record<Phase, number> = {
  prepare: 5, pkb: 20, analyze: 35, posting: 90, done: 100,
};
const ANALYZE_CAP = 85;
const EXPECTED_ANALYZE_MS: Record<ReviewStrategy, number> = {
  debate: 210_000, personas: 210_000, standard: 90_000,
};
export const PHASE_LABEL: Record<Phase, string> = {
  prepare: "準備工作區", pkb: "建立/載入知識庫", analyze: "分析中",
  posting: "貼上 review", done: "完成",
};

/** Map an mra `onProgress` stdout line to a phase (undefined = no transition). */
export function phaseFromLine(line: string): Phase | undefined {
  if (line.includes("review posted")) return "done";
  if (line.includes("posting inline review")) return "posting";
  if (line.includes("loaded existing PR discussion")) return "analyze";
  if (line.includes("PKB available") || line.includes("updating PKB")) return "pkb";
  if (line.includes("reviewing ")) return "prepare";
  return undefined;
}

/** Clamped, monotonic percent. `analyze` creeps by elapsed time toward ANALYZE_CAP. */
export function computePct(phase: Phase, elapsedInPhaseMs: number, strategy: ReviewStrategy): number {
  if (phase !== "analyze") return PHASE_FLOOR[phase];
  const floor = PHASE_FLOOR.analyze;
  const span = ANALYZE_CAP - floor;
  const frac = Math.min(1, Math.max(0, elapsedInPhaseMs / EXPECTED_ANALYZE_MS[strategy]));
  return Math.min(ANALYZE_CAP, Math.round(floor + span * frac));
}

/** `<headline>\n▰▰▰▱▱ NN%\n目前:<label>` — 5 cells, round(pct/20) filled. */
export function renderBar(pct: number, phaseLabel: string, headline: string): string {
  const filled = Math.max(0, Math.min(5, Math.round(pct / 20)));
  const bar = "▰".repeat(filled) + "▱".repeat(5 - filled);
  return `${headline}\n${bar} ${pct}%\n目前:${phaseLabel}`;
}
