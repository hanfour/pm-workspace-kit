import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  addEvidence,
  addHypothesis,
  addQuestion,
  assertSafeCaseName,
  appendTimeline,
  applyCaseUpdate,
  caseExists,
  CASE_VERSION,
  casePath,
  casesDir,
  listCases,
  loadCase,
  newCase,
  parseCaseUpdate,
  renderCaseMarkdown,
  resolveQuestion,
  saveCase,
  setHypothesisStatus,
  stripCaseUpdateBlock,
  withCaseLock,
} from "../src/case";

const ORIG_HOME = process.env.HOME;

describe("case file lifecycle", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-case-home-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  it("save → load round-trips and bumps updatedAt", async () => {
    const c = newCase({
      name: "demo",
      title: "Demo bug",
      symptom: "x is broken",
    });
    const file = saveCase(c);
    assert.equal(file, casePath("demo"));
    const loaded = loadCase("demo");
    assert.equal(loaded.name, "demo");
    assert.equal(loaded.title, "Demo bug");
    assert.equal(loaded.symptom, "x is broken");
    assert.equal(loaded.version, CASE_VERSION);
    assert.equal(loaded.status, "open");

    // Mutate + save again; updatedAt must move forward.
    const before = loaded.updatedAt;
    await new Promise((r) => setTimeout(r, 10));
    addHypothesis(loaded, "could be cache");
    saveCase(loaded);
    const reloaded = loadCase("demo");
    assert.notEqual(reloaded.updatedAt, before);
    assert.equal(reloaded.hypotheses.length, 1);
  });

  it("listCases returns name+title+status, newest first", () => {
    const a = newCase({ name: "alpha", title: "first" });
    const b = newCase({ name: "beta", title: "second" });
    saveCase(a);
    saveCase(b);
    // Mutate alpha → updatedAt becomes newer than beta
    addHypothesis(a, "h");
    saveCase(a);
    const list = listCases();
    assert.equal(list.length, 2);
    assert.equal(list[0].name, "alpha");
    assert.equal(list[0].title, "first");
  });

  it("listCases skips unreadable files", () => {
    const c = newCase({ name: "good" });
    saveCase(c);
    fs.writeFileSync(path.join(casesDir(), "broken.json"), "{ not json");
    const list = listCases();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "good");
  });

  it("caseExists / loadCase missing throws", () => {
    assert.equal(caseExists("nope"), false);
    assert.throws(() => loadCase("nope"), /case not found/);
  });

  it("loadCase rejects unknown schema version", () => {
    fs.mkdirSync(casesDir(), { recursive: true });
    fs.writeFileSync(
      casePath("future"),
      JSON.stringify({ ...newCase({ name: "future" }), version: 999 }),
    );
    assert.throws(() => loadCase("future"), /version 999/);
  });

  it("rejects path-traversal case names before any filesystem access", () => {
    for (const name of ["../escaped", "nested/file", "nested\\file", "..", ""]) {
      assert.throws(() => assertSafeCaseName(name), /unsafe case name/);
    }
  });

  it("serializes concurrent work for the same case", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });

    const first = withCaseLock("shared", undefined, async () => {
      order.push("first-start");
      markFirstStarted();
      await firstBlocked;
      order.push("first-end");
    });
    const second = withCaseLock("shared", undefined, async () => {
      order.push("second");
    });

    await firstStarted;
    assert.deepEqual(order, ["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first-start", "first-end", "second"]);
  });
});

describe("hypothesis + evidence + question mutators", () => {
  it("addHypothesis appends with status=open", () => {
    const c = newCase({ name: "x" });
    const h = addHypothesis(c, "browser cache");
    assert.equal(c.hypotheses.length, 1);
    assert.equal(h.status, "open");
    assert.equal(h.text, "browser cache");
    assert.ok(h.id.startsWith("h-"));
  });

  it("setHypothesisStatus by 1-based index updates status + note", () => {
    const c = newCase({ name: "x" });
    addHypothesis(c, "first");
    addHypothesis(c, "second");
    const h = setHypothesisStatus(c, 2, "ruled-out", "tested in incognito");
    assert.equal(h?.text, "second");
    assert.equal(c.hypotheses[1].status, "ruled-out");
    assert.equal(c.hypotheses[1].note, "tested in incognito");
  });

  it("setHypothesisStatus returns undefined for bad index", () => {
    const c = newCase({ name: "x" });
    addHypothesis(c, "only");
    assert.equal(setHypothesisStatus(c, 5, "confirmed"), undefined);
  });

  it("addEvidence + addQuestion append with timestamps", () => {
    const c = newCase({ name: "x" });
    addEvidence(c, "reporter", "console.log shows null");
    addQuestion(c, "what browser version?");
    assert.equal(c.evidence.length, 1);
    assert.equal(c.evidence[0].source, "reporter");
    assert.equal(c.openQuestions.length, 1);
    assert.equal(c.openQuestions[0].text, "what browser version?");
    assert.ok(c.evidence[0].at);
    assert.ok(c.openQuestions[0].addedAt);
  });

  it("resolveQuestion removes by 1-based index", () => {
    const c = newCase({ name: "x" });
    addQuestion(c, "q1");
    addQuestion(c, "q2");
    addQuestion(c, "q3");
    const q = resolveQuestion(c, 2);
    assert.equal(q?.text, "q2");
    assert.equal(c.openQuestions.length, 2);
    assert.deepEqual(
      c.openQuestions.map((q) => q.text),
      ["q1", "q3"],
    );
  });

  it("appendTimeline records kind + content", () => {
    const c = newCase({ name: "x" });
    appendTimeline(c, "slash", "/show");
    appendTimeline(c, "user", "is it cached?");
    assert.equal(c.timeline.length, 2);
    assert.equal(c.timeline[0].kind, "slash");
    assert.equal(c.timeline[1].content, "is it cached?");
  });
});

describe("parseCaseUpdate + applyCaseUpdate", () => {
  it("parses every action kind from a fenced block", () => {
    const response = `Some prose answer.

\`\`\`case-update
symptom: checkbox missing for some users
hypothesis: browser cache
hypothesis: feature flag in localStorage
rule-out 1: still missing in incognito
confirm 2: cleared by removing localStorage key
evidence: reporter saw it again after Cmd+Shift+R
next-question: what role does the user have?
resolve 3
\`\`\``;

    const { actions } = parseCaseUpdate(response);
    assert.equal(actions.length, 8);
    assert.deepEqual(actions[0], {
      kind: "symptom",
      text: "checkbox missing for some users",
    });
    assert.deepEqual(actions[1], { kind: "hypothesis", text: "browser cache" });
    assert.deepEqual(actions[3], {
      kind: "rule-out",
      index: 1,
      note: "still missing in incognito",
    });
    assert.deepEqual(actions[4], {
      kind: "confirm",
      index: 2,
      note: "cleared by removing localStorage key",
    });
    assert.deepEqual(actions[7], { kind: "resolve", index: 3 });
  });

  it("returns no actions when the block is absent", () => {
    const r = parseCaseUpdate("just prose, no fence");
    assert.deepEqual(r.actions, []);
    assert.equal(r.raw, "");
  });

  it("ignores malformed lines and keeps the rest", () => {
    const response = `\`\`\`case-update
hypothesis: good one
this line has no colon
rule-out: missing index
hypothesis: another good one
\`\`\``;
    const { actions } = parseCaseUpdate(response);
    assert.equal(actions.length, 2);
    assert.deepEqual(actions, [
      { kind: "hypothesis", text: "good one" },
      { kind: "hypothesis", text: "another good one" },
    ]);
  });

  it("stripCaseUpdateBlock removes the fenced block from prose", () => {
    const response = `Visible prose here.

\`\`\`case-update
hypothesis: x
\`\`\``;
    const stripped = stripCaseUpdateBlock(response);
    assert.equal(stripped, "Visible prose here.");
  });

  it("applyCaseUpdate skips duplicate hypotheses (case-insensitive)", () => {
    const c = newCase({ name: "x" });
    addHypothesis(c, "Browser Cache");
    applyCaseUpdate(c, [
      { kind: "hypothesis", text: "browser cache" }, // dup
      { kind: "hypothesis", text: "feature flag" },
    ]);
    assert.equal(c.hypotheses.length, 2);
    assert.equal(c.hypotheses[1].text, "feature flag");
  });

  it("applyCaseUpdate skips duplicate next-questions", () => {
    const c = newCase({ name: "x" });
    addQuestion(c, "What role?");
    applyCaseUpdate(c, [
      { kind: "next-question", text: "what role?" },
      { kind: "next-question", text: "What browser?" },
    ]);
    assert.equal(c.openQuestions.length, 2);
  });

  it("applyCaseUpdate returns human-readable summaries", () => {
    const c = newCase({ name: "x" });
    const summaries = applyCaseUpdate(c, [
      { kind: "symptom", text: "ABC" },
      { kind: "hypothesis", text: "first guess" },
      { kind: "next-question", text: "ask reporter for HAR" },
    ]);
    assert.equal(summaries.length, 3);
    assert.match(summaries[0], /symptom set/);
    assert.match(summaries[1], /hypothesis #1/);
    assert.match(summaries[2], /next-question #1/);
  });
});

describe("renderCaseMarkdown", () => {
  it("renders symptom, hypotheses, evidence, questions", () => {
    const c = newCase({
      name: "checkbox",
      title: "Cue checkbox missing",
      symptom: "some users see no checkbox",
    });
    addHypothesis(c, "browser cache");
    setHypothesisStatus(c, 1, "ruled-out", "still broken in incognito");
    addHypothesis(c, "feature flag");
    addEvidence(c, "reporter", "still missing in incognito");
    addQuestion(c, "what role does the user have?");

    const md = renderCaseMarkdown(c);
    assert.match(md, /# Case: Cue checkbox missing/);
    assert.match(md, /some users see no checkbox/);
    assert.match(md, /✗ ruled-out.*browser cache/);
    assert.match(md, /○ open.*feature flag/);
    assert.match(md, /still missing in incognito/);
    assert.match(md, /what role does the user have/);
  });

  it("uses placeholders for empty sections", () => {
    const c = newCase({ name: "empty" });
    const md = renderCaseMarkdown(c);
    assert.match(md, /## Symptom\s*\n\s*\n_\(none yet\)_/);
    assert.match(md, /## Hypotheses\s*\n\s*\n_\(none yet\)_/);
    assert.match(md, /## Open questions\s*\n\s*\n_\(none\)_/);
  });
});
