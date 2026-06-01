# Adoption Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A top-level `pmk adoption [--days N] [--json]` command that answers "is anyone using this?" with five metrics — four computed from the existing audit aggregation + atom telemetry, plus one new marker (time-to-first-PRD).

**Architecture:** A new `~/.pmk/adoption.json` marker file (write-if-absent, failure-isolated) records `firstRunAt` (at CLI entry) and `firstPrdAt` (on propose success), plus a `preExisting` flag so existing installs don't report a bogus time-to-first-PRD. A pure `buildAdoptionReport(audit, telemetry, atoms, markers, nowMs, windowDays)` combines `buildAuditReport` output + the telemetry sidecar + the markers into an `AdoptionReport`; the command does the I/O and renders text/json.

**Tech Stack:** TypeScript (Node ESM), `node:test`, `node:fs`, Commander. Spec: `docs/superpowers/specs/2026-06-01-adoption-metrics-design.md`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `packages/cli/src/run-markers.ts` (new) | `~/.pmk/adoption.json` markers: `readMarkers` / `recordFirstRun` (with `preExisting` detection) / `recordFirstPrd`; sync, write-if-absent, failure-isolated, temp+rename |
| `packages/cli/src/adoption.ts` (new) | pure `buildAdoptionReport(...)` + `AdoptionReport` type |
| `packages/cli/src/commands/adoption.ts` (new) | `pmk adoption` command — reads sources, renders text + json |
| `packages/cli/src/index.ts` (modify) | `recordFirstRun()` at entry + register the `adoption` command |
| `packages/cli/src/commands/propose.ts` (modify) | `recordFirstPrd()` in `maybeSavePrd` on success |
| `packages/cli/test/adoption.test.ts` (new) | markers + builder + command-render tests |

---

## Task 1: Run markers module

**Files:**
- Create: `packages/cli/src/run-markers.ts`
- Test: `packages/cli/test/adoption.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/adoption.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ORIG_HOME = process.env.HOME;

describe("run-markers", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-markers-"));
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  it("readMarkers returns nulls + preExisting:false when absent", async () => {
    const { readMarkers } = await import("../src/run-markers");
    assert.deepEqual(readMarkers(), {
      firstRunAt: null,
      firstPrdAt: null,
      preExisting: false,
    });
  });

  it("recordFirstRun writes once; second call does not overwrite", async () => {
    const { recordFirstRun, readMarkers } = await import("../src/run-markers");
    recordFirstRun("2026-06-01T00:00:00.000Z");
    recordFirstRun("2026-06-02T00:00:00.000Z");
    assert.equal(readMarkers().firstRunAt, "2026-06-01T00:00:00.000Z");
  });

  it("recordFirstRun sets preExisting:false on an empty ~/.pmk", async () => {
    const { recordFirstRun, readMarkers } = await import("../src/run-markers");
    recordFirstRun("2026-06-01T00:00:00.000Z");
    assert.equal(readMarkers().preExisting, false);
  });

  it("recordFirstRun sets preExisting:true when ~/.pmk already has state", async () => {
    fs.mkdirSync(path.join(tmpHome, ".pmk"), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, ".pmk", "gateway.json"), "{}");
    const { recordFirstRun, readMarkers } = await import("../src/run-markers");
    recordFirstRun("2026-06-01T00:00:00.000Z");
    assert.equal(readMarkers().preExisting, true);
  });

  it("recordFirstPrd writes once; preserves firstRunAt", async () => {
    const { recordFirstRun, recordFirstPrd, readMarkers } = await import("../src/run-markers");
    recordFirstRun("2026-06-01T00:00:00.000Z");
    recordFirstPrd("2026-06-01T04:00:00.000Z");
    recordFirstPrd("2026-06-09T00:00:00.000Z");
    const m = readMarkers();
    assert.equal(m.firstRunAt, "2026-06-01T00:00:00.000Z");
    assert.equal(m.firstPrdAt, "2026-06-01T04:00:00.000Z");
  });
});
```

> NOTE — fresh `await import(...)` per test is safe here: `run-markers.ts` keeps no module-level state; every path is re-derived from `os.homedir()` (which honours `$HOME`) on each call.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/adoption.test.ts`
Expected: FAIL — `Cannot find module '../src/run-markers'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/cli/src/run-markers.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && node --import tsx --test test/adoption.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/run-markers.ts packages/cli/test/adoption.test.ts
git commit -m "feat(cli): adoption run markers (first-run / first-prd, preExisting)"
```

---

## Task 2: `buildAdoptionReport` pure builder

**Files:**
- Create: `packages/cli/src/adoption.ts`
- Test: `packages/cli/test/adoption.test.ts` (add a describe block)

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/test/adoption.test.ts`:

```ts
import type { AuditReport } from "../src/gateway/audit";
import type { AtomTelemetryStore } from "../src/gateway/atom-telemetry";

function fakeAudit(over: Partial<AuditReport> = {}): AuditReport {
  return {
    windowDays: 7,
    windowStartMs: 0,
    windowEndMs: 0,
    conversations: { totalTurns: 20, perUser: [], perAudience: [] },
    mraAsk: { invocations: 8, successes: 6, retries: 0, failures: 2, medianDurationMs: undefined, topRepos: [] },
    escalate: { triggered: 5, absorbed: 3, pending: 0, medianTimeToReplyMs: undefined },
    atoms: { total: 0, approved: 0, pending: 0, retrievalInjections: 0, medianAtomsInjectedPerTurn: undefined, topContributors: [] },
    contextSafety: {} as AuditReport["contextSafety"],
    tokenUsage: {} as AuditReport["tokenUsage"],
    flags: [],
    ...over,
  };
}
function fakeTel(atoms: Record<string, number>): AtomTelemetryStore {
  return {
    version: 1,
    atoms: Object.fromEntries(Object.entries(atoms).map(([id, n]) => [id, { reuseCount: n, lastRetrievedAt: null, questionedCount: 0, lastQuestionedAt: null }])),
    questionedKeys: [],
  };
}
const atom = (id: string) => ({ id, status: "approved" as const, question: "", answer: "", scope: "s", createdAt: 0, tags: [], source: { threadKey: "", contributorUserId: "" } });

describe("buildAdoptionReport", () => {
  it("computes the four window/cumulative metrics", async () => {
    const { buildAdoptionReport } = await import("../src/adoption");
    const r = buildAdoptionReport(
      fakeAudit(),
      fakeTel({ a: 3, b: 0 }),
      [atom("a"), atom("b")],
      { firstRunAt: "2026-06-01T00:00:00.000Z", firstPrdAt: "2026-06-01T06:00:00.000Z", preExisting: false },
      Date.parse("2026-06-08T00:00:00.000Z"),
      7,
    );
    assert.equal(r.answeredQuestions.total, 20);
    // self-answer = (20 - 5) / 20 = 0.75
    assert.equal(r.selfAnswerRate.rate, 0.75);
    // conversion = 3 / 5 = 0.6
    assert.equal(r.escalationToSavedAtom.rate, 0.6);
    // reuse = 1 of 2 approved atoms reused = 0.5
    assert.equal(r.atomReuseRate.rate, 0.5);
    assert.equal(r.atomReuseRate.totalReuses, 3);
    // time-to-first-PRD = 6h
    assert.equal(r.timeToFirstPrd.durationMs, 6 * 3600_000);
  });

  it("division-by-zero and marker states render n/a", async () => {
    const { buildAdoptionReport } = await import("../src/adoption");
    const r = buildAdoptionReport(
      fakeAudit({ conversations: { totalTurns: 0, perUser: [], perAudience: [] }, escalate: { triggered: 0, absorbed: 0, pending: 0, medianTimeToReplyMs: undefined } }),
      fakeTel({}),
      [],
      { firstRunAt: null, firstPrdAt: null, preExisting: false },
      Date.parse("2026-06-08T00:00:00.000Z"),
      7,
    );
    assert.equal(r.selfAnswerRate.rate, null);
    assert.equal(r.escalationToSavedAtom.rate, null);
    assert.equal(r.atomReuseRate.rate, null);
    assert.match(r.timeToFirstPrd.display, /unknown/);
  });

  it("preExisting marks time-to-first-PRD n/a even with both timestamps", async () => {
    const { buildAdoptionReport } = await import("../src/adoption");
    const r = buildAdoptionReport(
      fakeAudit(),
      fakeTel({}),
      [],
      { firstRunAt: "2026-06-01T00:00:00.000Z", firstPrdAt: "2026-06-01T06:00:00.000Z", preExisting: true },
      Date.parse("2026-06-08T00:00:00.000Z"),
      7,
    );
    assert.equal(r.timeToFirstPrd.durationMs, null);
    assert.match(r.timeToFirstPrd.display, /existing install/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/adoption.test.ts`
Expected: FAIL — `Cannot find module '../src/adoption'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/cli/src/adoption.ts`:

```ts
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

function formatDuration(ms: number): string {
  if (ms < 0) return "n/a";
  const h = ms / 3600_000;
  if (h < 1) return `${Math.round(ms / 60_000)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
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
  const selfRate = total > 0 ? (total - triggered) / total : null;

  const savedAtom = audit.escalate.absorbed;
  const convRate = triggered > 0 ? savedAtom / triggered : null;

  const approved = atoms.filter((a) => a.status === "approved" || a.status === undefined);
  const reused = approved.filter((a) => (telemetry.atoms[a.id]?.reuseCount ?? 0) > 0).length;
  const reuseRate = approved.length > 0 ? reused / approved.length : null;
  const totalReuses = approved.reduce((s, a) => s + (telemetry.atoms[a.id]?.reuseCount ?? 0), 0);

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
      display: approved.length > 0 ? pct(reuseRate) : "n/a (no approved atoms)",
      reused,
      approved: approved.length,
      totalReuses,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && node --import tsx --test test/adoption.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS (8 tests); tsc exit 0.

> If `AuditReport` has required fields beyond those in `fakeAudit` (e.g. `contextSafety` / `tokenUsage` shapes), the `as` casts in the test fixture satisfy the type; `buildAdoptionReport` only reads `conversations`, `mraAsk`, and `escalate`, so unused fields don't matter.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/adoption.ts packages/cli/test/adoption.test.ts
git commit -m "feat(cli): buildAdoptionReport — 5 adoption metrics from audit + telemetry"
```

---

## Task 3: Wire instrumentation (entry + propose)

**Files:**
- Modify: `packages/cli/src/index.ts` (entry, after `dotenv.config(...)`)
- Modify: `packages/cli/src/commands/propose.ts` (`maybeSavePrd`, ~line 201)
- Test: `packages/cli/test/adoption.test.ts` (propose-records-on-success)

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/test/adoption.test.ts`:

```ts
describe("propose records first-prd on success", () => {
  let tmpHome2: string;
  beforeEach(() => {
    tmpHome2 = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-prop-"));
    process.env.HOME = tmpHome2;
  });
  afterEach(() => {
    fs.rmSync(tmpHome2, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  it("recordFirstPrd has run after a successful save (marker set)", async () => {
    // Direct-call contract test: maybeSavePrd's success path calls
    // recordFirstPrd(). We assert the wiring by calling recordFirstPrd
    // (the same function the success path calls) and confirming the
    // marker lands. (Driving the full propose LLM flow needs a model;
    // the success-only call site is verified by reading the diff.)
    const { recordFirstPrd, readMarkers } = await import("../src/run-markers");
    recordFirstPrd("2026-06-01T05:00:00.000Z");
    assert.equal(readMarkers().firstPrdAt, "2026-06-01T05:00:00.000Z");
  });
});
```

> This task's real verification is the spec-compliance review reading the two call sites. The unit test locks the marker contract; the wiring (calling it at the right place) is reviewed, not mocked.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/adoption.test.ts`
Expected: PASS for the marker assertion (it reuses Task 1's function) — but the WIRING in index.ts / propose.ts is not yet present. Proceed to add it (Step 3); the contract test guards regressions.

- [ ] **Step 3: Write the implementation**

In `packages/cli/src/index.ts`, add the import with the other command imports near the top:

```ts
import { recordFirstRun } from "./run-markers";
```

Immediately after `dotenv.config({ quiet: true });`, add:

```ts
// P4: stamp the first-ever pmk run (write-if-absent, failure-isolated).
recordFirstRun();
```

In `packages/cli/src/commands/propose.ts`, add the import with the other imports near the top:

```ts
import { recordFirstPrd } from "../run-markers";
```

In `maybeSavePrd`, after the PRD is written and before `return true` (the lines that currently read `const saved = writePrd(...)` / `println(...)` / `return true;`), add the `recordFirstPrd()` call:

```ts
  const saved = writePrd(stamped, title, docsDir);
  println(chalk.green(`\nPRD saved → ${path.relative(process.cwd(), saved)}`));
  println(chalk.dim(`  doc_id: ${id}`));
  // P4: stamp the first PRD ever written (write-if-absent, failure-isolated).
  recordFirstPrd();
  return true;
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd packages/cli && node --import tsx --test test/adoption.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS; tsc exit 0. Also confirm `recordFirstRun` is called exactly once at entry and `recordFirstPrd` only on the success path of `maybeSavePrd`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/src/commands/propose.ts packages/cli/test/adoption.test.ts
git commit -m "feat(cli): record first-run at entry + first-prd on propose success"
```

---

## Task 4: `pmk adoption` command

**Files:**
- Create: `packages/cli/src/commands/adoption.ts`
- Modify: `packages/cli/src/index.ts` (register the command)
- Test: `packages/cli/test/adoption.test.ts` (render assertions)

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/test/adoption.test.ts`:

```ts
describe("renderAdoptionText", () => {
  it("renders each metric line with its value", async () => {
    const { renderAdoptionText } = await import("../src/commands/adoption");
    const { buildAdoptionReport } = await import("../src/adoption");
    const report = buildAdoptionReport(
      fakeAudit(),
      fakeTel({ a: 3, b: 0 }),
      [atom("a"), atom("b")],
      { firstRunAt: "2026-06-01T00:00:00.000Z", firstPrdAt: "2026-06-01T06:00:00.000Z", preExisting: false },
      Date.parse("2026-06-08T00:00:00.000Z"),
      7,
    );
    const text = renderAdoptionText(report);
    assert.match(text, /time-to-first-PRD/i);
    assert.match(text, /answered questions/i);
    assert.match(text, /self-answer/i);
    assert.match(text, /saved atom/i);
    assert.match(text, /reuse/i);
    assert.match(text, /75%/); // self-answer rate
    assert.match(text, /60%/); // conversion
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && node --import tsx --test test/adoption.test.ts`
Expected: FAIL — `renderAdoptionText` is not exported from `../src/commands/adoption`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/cli/src/commands/adoption.ts`:

```ts
import chalk from "chalk";
import { buildAuditReport } from "../gateway/audit";
import { loadTelemetry } from "../gateway/atom-telemetry";
import { loadAtoms } from "../gateway/knowledge";
import { readMarkers } from "../run-markers";
import { buildAdoptionReport, type AdoptionReport } from "../adoption";

function println(s = ""): void {
  // eslint-disable-next-line no-console
  console.log(s);
}

export function renderAdoptionText(r: AdoptionReport): string {
  const lines: string[] = [];
  lines.push(chalk.bold("\npmk adoption — is anyone using this?"));
  lines.push(chalk.dim(`  window: last ${r.windowDays} day(s); reuse is cumulative; time-to-first-PRD is one-time\n`));
  lines.push(`  time-to-first-PRD:        ${r.timeToFirstPrd.display}`);
  lines.push(`  answered questions:       ${r.answeredQuestions.total} (${r.answeredQuestions.perWeek.toFixed(1)}/week)`);
  lines.push(
    `  self-answer rate:         ${r.selfAnswerRate.display}` +
      `  ${chalk.dim(`(mra-ask ${r.selfAnswerRate.mraAsk.successes}/${r.selfAnswerRate.mraAsk.invocations})`)}`,
  );
  lines.push(
    `  escalation → saved atom:  ${r.escalationToSavedAtom.display}` +
      `  ${chalk.dim(`(${r.escalationToSavedAtom.savedAtom}/${r.escalationToSavedAtom.triggered})`)}`,
  );
  lines.push(
    `  atom reuse rate:          ${r.atomReuseRate.display}` +
      `  ${chalk.dim(`(${r.atomReuseRate.reused}/${r.atomReuseRate.approved} atoms, ${r.atomReuseRate.totalReuses} reuses)`)}`,
  );
  return lines.join("\n");
}

export function adoptionCommand(opts: { days?: string; json?: boolean }): void {
  const parsed = opts.days !== undefined ? Number.parseInt(opts.days, 10) : NaN;
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
  const nowMs = Date.now();
  const report = buildAdoptionReport(
    buildAuditReport({ days, nowMs }),
    loadTelemetry(),
    loadAtoms({ promote: false }),
    readMarkers(),
    nowMs,
    days,
  );
  if (opts.json) {
    println(JSON.stringify(report, null, 2));
    return;
  }
  println(renderAdoptionText(report));
}
```

In `packages/cli/src/index.ts`, add the import near the other command imports:

```ts
import { adoptionCommand } from "./commands/adoption";
```

And register the command (place it next to the other `program.command(...)` blocks, e.g. after the `gateway` registration):

```ts
program
  .command("adoption")
  .description("adoption metrics — is anyone using this?")
  .option("--days <n>", "lookback window in days (default 7)")
  .option("--json", "emit the structured AdoptionReport")
  .action((opts: { days?: string; json?: boolean }) => {
    adoptionCommand(opts);
  });
```

- [ ] **Step 4: Run tests + typecheck + manual smoke**

Run: `cd packages/cli && node --import tsx --test test/adoption.test.ts && npm run typecheck:test && npx tsc -p tsconfig.json --noEmit`
Expected: PASS; both tsc exit 0.
Manual: `npx tsx src/index.ts adoption` prints the report and exits 0; `npx tsx src/index.ts adoption --json` prints a JSON object; `npx tsx src/index.ts adoption --days 30` widens the window.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/adoption.ts packages/cli/src/index.ts packages/cli/test/adoption.test.ts
git commit -m "feat(cli): pmk adoption command (text + --json)"
```

---

## Task 5: Full-suite green

- [ ] **Step 1: Run the whole CLI suite**

Run: `npm --workspace packages/cli test`
Expected: all pass (prior 459 + new adoption tests), `typecheck:test` clean.

- [ ] **Step 2: Typecheck src**

Run: `cd packages/cli && npx tsc -p tsconfig.json --noEmit`
Expected: EXIT 0.

- [ ] **Step 3: Commit any fixups** (only if Steps 1–2 surfaced issues)

```bash
git add -A && git commit -m "test(cli): adoption metrics suite green"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** markers + preExisting → Task 1; the 5 metrics + n/a edge cases + purity → Task 2; entry/propose instrumentation → Task 3; top-level `pmk adoption [--days N] [--json]` + render → Task 4. buildAuditReport called as `{ days, nowMs }` (Task 4) per the corrected spec. Metric 4 = `escalate.absorbed / escalate.triggered` (saved-atom). All covered.
- **Placeholder scan:** every code step has complete code; Task 3's wiring is a contract-test + reviewed call site (explicitly noted, not a hidden TODO).
- **Type consistency:** `AdoptionMarkers` (run-markers) consumed by `buildAdoptionReport` (adoption.ts) and `adoptionCommand` (command); `AdoptionReport` shape used identically in builder, render, and tests; `recordFirstRun` / `recordFirstPrd` / `readMarkers` names consistent across Tasks 1/3/4.

## Out of scope (future)

Cross-host aggregation, trend-over-time, surfacing adoption inside `gateway audit`.
