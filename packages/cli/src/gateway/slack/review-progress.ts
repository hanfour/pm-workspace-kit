import type { WebClient } from "@slack/web-api";
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

const TICK_MS = 5000;

interface ProgressDeps {
  web: Pick<WebClient, "chat">;
  channel: string;
  ts: string;
  strategy: ReviewStrategy;
  headline: string;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearTimer?: (h: ReturnType<typeof setInterval>) => void;
}

export class ReviewProgress {
  private phase: Phase = "prepare";
  private phaseStart: number;
  private lastRender = "";
  private timer?: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  private readonly clearTimer: (h: ReturnType<typeof setInterval>) => void;

  constructor(private readonly d: ProgressDeps) {
    this.now = d.now ?? Date.now;
    this.clearTimer = d.clearTimer ?? clearInterval;
    this.phaseStart = this.now();
    const set = d.setTimer ?? setInterval;
    this.timer = set(() => void this.tick(), TICK_MS);
  }

  onLine(line: string): void {
    const next = phaseFromLine(line);
    if (next && next !== this.phase) {
      this.phase = next;
      this.phaseStart = this.now();
      void this.tick();
    }
  }

  private async tick(): Promise<void> {
    if (this.phase === "done") return;
    const pct = computePct(this.phase, this.now() - this.phaseStart, this.d.strategy);
    const text = renderBar(pct, PHASE_LABEL[this.phase], this.d.headline);
    if (text === this.lastRender) return;
    this.lastRender = text;
    try {
      await (this.d.web.chat.update as (args: never) => Promise<unknown>)({ channel: this.d.channel, ts: this.d.ts, text } as never);
    } catch {
      /* best-effort; a Slack hiccup must not break the review */
    }
  }

  async finish(finalText: string): Promise<void> {
    this.dispose();
    try {
      await (this.d.web.chat.update as (args: never) => Promise<unknown>)({ channel: this.d.channel, ts: this.d.ts, text: finalText } as never);
    } catch {
      /* best-effort */
    }
  }

  dispose(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }
}
