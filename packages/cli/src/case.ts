import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatMessage } from "@pmk/shared";

/**
 * pmk case file — a long-lived bug investigation that accumulates
 * symptom, hypotheses, evidence, and pending questions across many
 * sessions. Distinct from `Session.park()` which is a one-shot
 * conversation snapshot.
 *
 * Stored at `~/.pmk/cases/<name>.json`. JSON v1 is intentionally
 * narrow — every field is something a real bug-investigation chat
 * already produces. Add fields after dogfood proves they're missed,
 * not before.
 */
export const CASE_VERSION = 1 as const;

export type HypothesisStatus = "open" | "ruled-out" | "confirmed";

export interface Hypothesis {
  id: string;
  text: string;
  status: HypothesisStatus;
  note?: string;
  addedAt: string;
}

export interface EvidenceEntry {
  id: string;
  at: string;
  source: "user" | "reporter" | "system";
  content: string;
}

export interface OpenQuestion {
  id: string;
  text: string;
  addedAt: string;
}

export interface TimelineEntry {
  at: string;
  kind: "user" | "assistant" | "slash";
  content: string;
}

export interface CaseFile {
  version: typeof CASE_VERSION;
  name: string;
  title: string;
  status: "open" | "closed";
  createdAt: string;
  updatedAt: string;
  ingest: string[];
  symptom: string;
  hypotheses: Hypothesis[];
  evidence: EvidenceEntry[];
  openQuestions: OpenQuestion[];
  resolution?: string;
  /** Full conversation history with the model — replayed when resumed. */
  messages: ChatMessage[];
  /** Lightweight high-level activity log; cheap to render in `pmk case show`. */
  timeline: TimelineEntry[];
}

/**
 * Default case directory: `~/.pmk/cases/`. The gateway uses different
 * roots (per-Slack-user, per-channel) so every accessor takes an
 * optional `baseDir` to override.
 */
export function casesDir(baseDir?: string): string {
  return baseDir ?? path.join(os.homedir(), ".pmk", "cases");
}

export function casePath(name: string, baseDir?: string): string {
  return path.join(casesDir(baseDir), `${name}.json`);
}

export function listCases(
  baseDir?: string,
): Array<Pick<CaseFile, "name" | "title" | "status" | "updatedAt">> {
  const dir = casesDir(baseDir);
  if (!fs.existsSync(dir)) return [];
  const out: Array<Pick<CaseFile, "name" | "title" | "status" | "updatedAt">> =
    [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const data = JSON.parse(
        fs.readFileSync(path.join(dir, f), "utf8"),
      ) as CaseFile;
      out.push({
        name: data.name,
        title: data.title,
        status: data.status,
        updatedAt: data.updatedAt,
      });
    } catch {
      /* ignore unreadable */
    }
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}

export function caseExists(name: string, baseDir?: string): boolean {
  return fs.existsSync(casePath(name, baseDir));
}

export function loadCase(name: string, baseDir?: string): CaseFile {
  const file = casePath(name, baseDir);
  if (!fs.existsSync(file)) {
    throw new Error(`case not found: ${name}`);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as CaseFile;
  if (raw.version !== CASE_VERSION) {
    throw new Error(
      `case ${name} has version ${raw.version}, this build expects ${CASE_VERSION}`,
    );
  }
  return raw;
}

export function saveCase(c: CaseFile, baseDir?: string): string {
  const file = casePath(c.name, baseDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  c.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(c, null, 2), "utf8");
  return file;
}

export function newCase(opts: {
  name: string;
  title?: string;
  ingest?: string[];
  symptom?: string;
}): CaseFile {
  const now = new Date().toISOString();
  return {
    version: CASE_VERSION,
    name: opts.name,
    title: opts.title ?? opts.name,
    status: "open",
    createdAt: now,
    updatedAt: now,
    ingest: opts.ingest ?? [],
    symptom: opts.symptom ?? "",
    hypotheses: [],
    evidence: [],
    openQuestions: [],
    messages: [],
    timeline: [],
  };
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export function addHypothesis(c: CaseFile, text: string): Hypothesis {
  const h: Hypothesis = {
    id: nextId("h"),
    text,
    status: "open",
    addedAt: new Date().toISOString(),
  };
  c.hypotheses.push(h);
  return h;
}

export function setHypothesisStatus(
  c: CaseFile,
  idOrIndex: string | number,
  status: HypothesisStatus,
  note?: string,
): Hypothesis | undefined {
  const h =
    typeof idOrIndex === "number"
      ? c.hypotheses[idOrIndex - 1]
      : c.hypotheses.find((x) => x.id === idOrIndex);
  if (!h) return undefined;
  h.status = status;
  if (note) h.note = note;
  return h;
}

export function addEvidence(
  c: CaseFile,
  source: EvidenceEntry["source"],
  content: string,
): EvidenceEntry {
  const e: EvidenceEntry = {
    id: nextId("e"),
    at: new Date().toISOString(),
    source,
    content,
  };
  c.evidence.push(e);
  return e;
}

export function addQuestion(c: CaseFile, text: string): OpenQuestion {
  const q: OpenQuestion = {
    id: nextId("q"),
    text,
    addedAt: new Date().toISOString(),
  };
  c.openQuestions.push(q);
  return q;
}

export function resolveQuestion(
  c: CaseFile,
  idOrIndex: string | number,
): OpenQuestion | undefined {
  const idx =
    typeof idOrIndex === "number"
      ? idOrIndex - 1
      : c.openQuestions.findIndex((q) => q.id === idOrIndex);
  if (idx < 0 || idx >= c.openQuestions.length) return undefined;
  return c.openQuestions.splice(idx, 1)[0];
}

export function appendTimeline(
  c: CaseFile,
  kind: TimelineEntry["kind"],
  content: string,
): void {
  c.timeline.push({
    at: new Date().toISOString(),
    kind,
    content,
  });
}

/**
 * Parsed action from the model's `case-update` fenced block.
 * One line in the block becomes one CaseUpdate.
 */
export type CaseUpdate =
  | { kind: "symptom"; text: string }
  | { kind: "hypothesis"; text: string }
  | { kind: "rule-out"; index: number; note: string }
  | { kind: "confirm"; index: number; note: string }
  | { kind: "evidence"; text: string }
  | { kind: "next-question"; text: string }
  | { kind: "resolve"; index: number };

/**
 * Pull the `case-update` fenced block (if any) out of an assistant
 * response. Returns the parsed actions plus the original block text
 * (so callers can strip it from the displayed response).
 */
export function parseCaseUpdate(response: string): {
  actions: CaseUpdate[];
  raw: string;
} {
  const fence = /```case-update\n([\s\S]*?)```/.exec(response);
  if (!fence) return { actions: [], raw: "" };
  const body = fence[1];
  const actions: CaseUpdate[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([a-z-]+)(?:\s+(\d+))?\s*:\s*(.+)$/.exec(line);
    if (!m) {
      // Allow bare `resolve N` with no value (we treat the index as the only payload).
      const bareIdx = /^([a-z-]+)\s+(\d+)\s*$/.exec(line);
      if (bareIdx && bareIdx[1] === "resolve") {
        actions.push({ kind: "resolve", index: parseInt(bareIdx[2], 10) });
      }
      continue;
    }
    const [, kind, idxStr, value] = m;
    switch (kind) {
      case "symptom":
        actions.push({ kind: "symptom", text: value });
        break;
      case "hypothesis":
        actions.push({ kind: "hypothesis", text: value });
        break;
      case "rule-out":
      case "confirm":
        if (idxStr === undefined) break;
        actions.push({
          kind,
          index: parseInt(idxStr, 10),
          note: value,
        });
        break;
      case "evidence":
        actions.push({ kind: "evidence", text: value });
        break;
      case "next-question":
        actions.push({ kind: "next-question", text: value });
        break;
      case "resolve":
        if (idxStr !== undefined) {
          actions.push({ kind: "resolve", index: parseInt(idxStr, 10) });
        }
        break;
    }
  }
  return { actions, raw: fence[0] };
}

/**
 * Strip a `case-update` fenced block from a response so the
 * user-facing text doesn't include the machine-readable directive.
 */
export function stripCaseUpdateBlock(response: string): string {
  return response
    .replace(/\n*```case-update\n[\s\S]*?```\s*$/, "")
    .replace(/```case-update\n[\s\S]*?```\n*/g, "")
    .trimEnd();
}

/**
 * Apply parsed actions to the case file, in order. Returns short
 * human-readable summaries of each successful application — caller
 * prints these as `✓` lines under the assistant turn so the user
 * sees what was tracked.
 */
export function applyCaseUpdate(c: CaseFile, actions: CaseUpdate[]): string[] {
  const out: string[] = [];
  for (const a of actions) {
    switch (a.kind) {
      case "symptom":
        c.symptom = a.text;
        out.push(`symptom set: ${truncateLine(a.text, 80)}`);
        break;
      case "hypothesis": {
        // Skip duplicates (same text, case-insensitive trim).
        const norm = a.text.trim().toLowerCase();
        if (c.hypotheses.some((h) => h.text.trim().toLowerCase() === norm)) {
          break;
        }
        addHypothesis(c, a.text);
        out.push(
          `hypothesis #${c.hypotheses.length}: ${truncateLine(a.text, 80)}`,
        );
        break;
      }
      case "rule-out":
      case "confirm": {
        const status = a.kind === "rule-out" ? "ruled-out" : "confirmed";
        const h = setHypothesisStatus(c, a.index, status, a.note);
        if (h) {
          out.push(`hypothesis #${a.index} → ${status}`);
        }
        break;
      }
      case "evidence":
        addEvidence(c, "system", a.text);
        out.push(`evidence #${c.evidence.length}: ${truncateLine(a.text, 80)}`);
        break;
      case "next-question": {
        const norm = a.text.trim().toLowerCase();
        if (c.openQuestions.some((q) => q.text.trim().toLowerCase() === norm)) {
          break;
        }
        addQuestion(c, a.text);
        out.push(
          `next-question #${c.openQuestions.length}: ${truncateLine(a.text, 80)}`,
        );
        break;
      }
      case "resolve": {
        const q = resolveQuestion(c, a.index);
        if (q) out.push(`resolved question #${a.index}`);
        break;
      }
    }
  }
  return out;
}

function truncateLine(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

/**
 * Render the case file as human-readable Markdown. Used by
 * `pmk case show`, and as the seed system context when the case is
 * resumed (so the model knows what the user already learned).
 */
export function renderCaseMarkdown(c: CaseFile): string {
  const lines: string[] = [];
  lines.push(`# Case: ${c.title}`);
  lines.push("");
  lines.push(`- **id**: \`${c.name}\``);
  lines.push(`- **status**: ${c.status}`);
  lines.push(`- **created**: ${c.createdAt}`);
  lines.push(`- **updated**: ${c.updatedAt}`);
  if (c.ingest.length) {
    lines.push(`- **ingest**: ${c.ingest.join(", ")}`);
  }
  if (c.resolution) {
    lines.push(`- **resolution**: ${c.resolution}`);
  }
  lines.push("");

  lines.push("## Symptom");
  lines.push("");
  lines.push(c.symptom || "_(none yet)_");
  lines.push("");

  lines.push("## Hypotheses");
  lines.push("");
  if (c.hypotheses.length === 0) lines.push("_(none yet)_");
  c.hypotheses.forEach((h, i) => {
    const tag =
      h.status === "confirmed"
        ? "✓ confirmed"
        : h.status === "ruled-out"
          ? "✗ ruled-out"
          : "○ open";
    lines.push(`${i + 1}. **[${tag}]** ${h.text}`);
    if (h.note) lines.push(`   _note_: ${h.note}`);
  });
  lines.push("");

  lines.push("## Evidence");
  lines.push("");
  if (c.evidence.length === 0) lines.push("_(none yet)_");
  c.evidence.forEach((e, i) => {
    lines.push(`${i + 1}. _(${e.source}, ${e.at})_ ${e.content}`);
  });
  lines.push("");

  lines.push("## Open questions");
  lines.push("");
  if (c.openQuestions.length === 0) lines.push("_(none)_");
  c.openQuestions.forEach((q, i) => {
    lines.push(`${i + 1}. ${q.text}`);
  });
  lines.push("");

  return lines.join("\n");
}
