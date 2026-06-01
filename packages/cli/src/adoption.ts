/**
 * Adoption metrics (P4). Pure builder — no I/O, no Date.now(): the caller
 * passes the audit report, telemetry store, atom corpus, run markers, the
 * current time, and the window. Answers "is anyone using this?".
 */
import type { AuditReport } from "./gateway/audit";
import type { AtomTelemetryStore } from "./gateway/atom-telemetry";
import type { KnowledgeAtom } from "./gateway/knowledge";
import type { AdoptionMarkers } from "./run-markers";

export interface RateMetric {
  /** null = n/a (e.g. divide-by-zero). */
  rate: number | null;
  display: string;
}

export interface AdoptionReport {
  windowDays: number;
  timeToFirstPrd: { durationMs: number | null; display: string };
  answeredQuestions: { total: number; perWeek: number };
  selfAnswerRate: RateMetric & { mraAsk: { successes: number; invocations: number } };
  escalationToSavedAtom: RateMetric & { savedAtom: number; triggered: number };
  atomReuseRate: RateMetric & { reused: number; approved: number; totalReuses: number };
}

function pct(rate: number | null): string {
  return rate === null ? "n/a" : `${Math.round(rate * 100)}%`;
}

/** Clamp a computed rate into [0,1]; window-boundary effects on the event
 * log can otherwise yield <0 or >1 on metrics derived from paired events. */
function clamp01(rate: number | null): number | null {
  if (rate === null) return null;
  return Math.min(1, Math.max(0, rate));
}

function formatDuration(ms: number): string {
  if (ms < 0) return "n/a";
  const h = ms / 3600_000;
  if (h < 1) return `${Math.round(ms / 60_000)}m`;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function timeToFirstPrd(m: AdoptionMarkers): { durationMs: number | null; display: string } {
  if (m.preExisting) {
    return { durationMs: null, display: "n/a (instrumentation added to an existing install)" };
  }
  if (!m.firstRunAt) return { durationMs: null, display: "unknown (pre-instrumentation)" };
  if (!m.firstPrdAt) return { durationMs: null, display: "no PRD yet" };
  const ms = Date.parse(m.firstPrdAt) - Date.parse(m.firstRunAt);
  return { durationMs: ms, display: formatDuration(ms) };
}

export function buildAdoptionReport(
  audit: AuditReport,
  telemetry: AtomTelemetryStore,
  atoms: KnowledgeAtom[],
  markers: AdoptionMarkers,
  nowMs: number,
  windowDays: number,
): AdoptionReport {
  void nowMs; // reserved for future relative formatting; windowing is done by buildAuditReport

  const total = audit.conversations.totalTurns;
  const perWeek = windowDays > 0 ? (total * 7) / windowDays : 0;

  const triggered = audit.escalate.triggered;
  const selfRate = clamp01(total > 0 ? (total - triggered) / total : null);

  const savedAtom = audit.escalate.absorbed;
  const convRate = clamp01(triggered > 0 ? savedAtom / triggered : null);

  const approvedAtoms = atoms.filter((a) => a.status === "approved" || a.status === undefined);
  const reused = approvedAtoms.filter((a) => (telemetry.atoms[a.id]?.reuseCount ?? 0) > 0).length;
  // reused is a subset-count of approvedAtoms so this is already in [0,1];
  // clamp for uniformity with the other rates (and future-proofing).
  const reuseRate = clamp01(approvedAtoms.length > 0 ? reused / approvedAtoms.length : null);
  const totalReuses = approvedAtoms.reduce((s, a) => s + (telemetry.atoms[a.id]?.reuseCount ?? 0), 0);

  return {
    windowDays,
    timeToFirstPrd: timeToFirstPrd(markers),
    answeredQuestions: { total, perWeek },
    selfAnswerRate: {
      rate: selfRate,
      display: total > 0 ? pct(selfRate) : "n/a (no turns)",
      mraAsk: { successes: audit.mraAsk.successes, invocations: audit.mraAsk.invocations },
    },
    escalationToSavedAtom: {
      rate: convRate,
      display: triggered > 0 ? pct(convRate) : "n/a (no escalations)",
      savedAtom,
      triggered,
    },
    atomReuseRate: {
      rate: reuseRate,
      display: approvedAtoms.length > 0 ? pct(reuseRate) : "n/a (no approved atoms)",
      reused,
      approved: approvedAtoms.length,
      totalReuses,
    },
  };
}
