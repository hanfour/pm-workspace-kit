import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AuditReport } from "../src/gateway/audit";
import type { AtomTelemetryStore } from "../src/gateway/atom-telemetry";

// Never point HOME back at the operator's home. Test files run in separate
// processes, so restoring buys nothing — and it opens a window that has
// already caused an outage: a cancelled test's abandoned continuation resumes
// AFTER afterEach, sees the real HOME, and writes to the live ~/.pmk. On
// 2026-08-04 that overwrote the gateway config with test fixtures and took
// the bot down. ORIG_HOME is a throwaway directory, never the real one.
const ORIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-safe-home-"));
process.env.HOME = ORIG_HOME;

describe("run-markers", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-markers-"));
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env.HOME = ORIG_HOME;
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

function fakeAudit(over: Partial<AuditReport> = {}): AuditReport {
  return {
    windowDays: 7,
    windowStartMs: 0,
    windowEndMs: 0,
    conversations: { totalTurns: 20, perUser: [], perAudience: [] },
    mraAsk: { invocations: 8, successes: 6, retries: 0, failures: 2, medianDurationMs: undefined, topRepos: [] },
    escalate: { triggered: 5, absorbed: 3, pending: 0, medianTimeToReplyMs: undefined },
    atoms: { total: 0, approved: 0, pending: 0, retrievalInjections: 0, medianAtomsInjectedPerTurn: undefined, topContributors: [] },
    reliability: { rejections: 0, fatal: 0 },
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
    assert.equal(r.selfAnswerRate.rate, 0.75);
    assert.equal(r.escalationToSavedAtom.rate, 0.6);
    assert.equal(r.atomReuseRate.rate, 0.5);
    assert.equal(r.atomReuseRate.totalReuses, 3);
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

  it("perWeek is 0 when windowDays is 0 (no divide-by-zero)", async () => {
    const { buildAdoptionReport } = await import("../src/adoption");
    const r = buildAdoptionReport(
      fakeAudit(),
      fakeTel({}),
      [],
      { firstRunAt: null, firstPrdAt: null, preExisting: false },
      Date.parse("2026-06-08T00:00:00.000Z"),
      0,
    );
    assert.equal(r.answeredQuestions.perWeek, 0);
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
    assert.match(text, /75%/);
    assert.match(text, /60%/);
  });
});

describe("propose records first-prd on success (marker contract)", () => {
  let tmpHome2: string;
  beforeEach(() => {
    tmpHome2 = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-prop-"));
    process.env.HOME = tmpHome2;
  });
  afterEach(() => {
    fs.rmSync(tmpHome2, { recursive: true, force: true });
    process.env.HOME = ORIG_HOME;
  });

  it("recordFirstPrd sets the marker (same fn the success path calls)", async () => {
    const { recordFirstPrd, readMarkers } = await import("../src/run-markers");
    recordFirstPrd("2026-06-01T05:00:00.000Z");
    assert.equal(readMarkers().firstPrdAt, "2026-06-01T05:00:00.000Z");
  });
});
