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
  // Analyze markers. `loaded existing PR discussion` is CONDITIONAL (only when the
  // PR already has discussion), so a fresh PR would never reach analyze on that
  // line alone. `running <provider>` (single-pass, review.sh) is UNCONDITIONAL on
  // stdout; the debate round markers are on stderr (usually invisible here) but
  // matched too, in case stderr is ever merged into the progress stream.
  if (
    /running (Claude|claude|Codex|codex|fallback|dual)\b/.test(line) ||
    line.includes("loaded existing PR discussion") ||
    line.includes("independent analysis") ||
    line.includes("mailbox voting") ||
    line.includes("synthesizing review")
  )
    return "analyze";
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
/**
 * How long a setup phase (prepare/pkb) may sit before we assume mra is actually
 * analyzing and advance the bar ourselves. mra's debate analysis markers go to
 * stderr (invisible to this stdout stream) and a fresh PR emits no PKB/discussion
 * line, so without this the bar would freeze at 5–20% for the whole analyze.
 * prepare→pkb→running-Claude normally happens within a couple of seconds (the
 * heavy PKB *build* runs as a separate step before the review), so 20s of no
 * transition reliably means "analyzing".
 */
const SETUP_BUDGET_MS = 20_000;

interface ProgressDeps {
  web: Pick<WebClient, "chat">;
  channel: string;
  ts: string;
  strategy: ReviewStrategy;
  headline: string;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearTimer?: (h: ReturnType<typeof setInterval>) => void;
  /** Log sink for best-effort update failures (so a lost update is debuggable). */
  onLog?: (m: string) => void;
}

export class ReviewProgress {
  private phase: Phase = "prepare";
  private phaseStart: number;
  private lastRender = "";
  private timer?: ReturnType<typeof setInterval>;
  private finished = false;
  /** Serializes all chat.update calls so a stale tick can't race finish(). */
  private chain: Promise<void> = Promise.resolve();
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
    if (this.finished) return;
    const next = phaseFromLine(line);
    if (next && next !== this.phase) {
      this.phase = next;
      this.phaseStart = this.now();
      void this.tick();
    }
  }

  /**
   * mra's analysis often produces no stdout phase marker (debate markers go to
   * stderr; a fresh PR has no PKB/discussion line). Once a setup phase overruns
   * the budget, treat it as analyze so the time-creep engages instead of freezing.
   */
  private maybeAutoAdvance(): void {
    if (
      (this.phase === "prepare" || this.phase === "pkb") &&
      this.now() - this.phaseStart > SETUP_BUDGET_MS
    ) {
      this.phase = "analyze";
      this.phaseStart = this.now();
    }
  }

  /**
   * Enqueue a chat.update on the serialized chain. Progress ticks (`isFinal`
   * false) are skipped once finish() has run, so a stale in-flight tick can
   * never overwrite the delivered result. Dedupe state is committed only on a
   * successful update, so a transient failure re-sends the same render next tick
   * instead of freezing the bar. Failures are logged (best-effort, non-fatal).
   */
  private queueUpdate(text: string, isFinal: boolean): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (this.finished && !isFinal) return;
      try {
        await (this.d.web.chat.update as (args: never) => Promise<unknown>)(
          { channel: this.d.channel, ts: this.d.ts, text } as never,
        );
        if (!isFinal) this.lastRender = text;
      } catch (err) {
        this.d.onLog?.(`review: progress update failed: ${(err as Error).message}`);
      }
    });
    return this.chain;
  }

  private async tick(): Promise<void> {
    if (this.finished) return;
    this.maybeAutoAdvance();
    if (this.phase === "done") return;
    const pct = computePct(this.phase, this.now() - this.phaseStart, this.d.strategy);
    const text = renderBar(pct, PHASE_LABEL[this.phase], this.d.headline);
    if (text === this.lastRender) return;
    await this.queueUpdate(text, false);
  }

  async finish(finalText: string): Promise<void> {
    this.finished = true;
    this.dispose();
    await this.queueUpdate(finalText, true);
  }

  dispose(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }
}
