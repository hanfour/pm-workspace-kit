import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEMO_SEED_TAG,
  findDemoAtoms,
  seedDemoAtom,
  unseedDemoAtoms,
} from "../src/gateway/demo-seed";
import { saveAtom, loadAtoms, type KnowledgeAtom } from "../src/gateway/knowledge";

let tmpHome: string;
let savedHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-demo-seed-"));
  savedHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("demo-seed — seedDemoAtom (FR4)", () => {
  it("writes one atom tagged demo-seed on first call", () => {
    const r = seedDemoAtom();
    assert.equal(r.written, true);
    assert.ok(r.atomId.startsWith("demo-seed-"));
    assert.ok(fs.existsSync(r.filePath), `expected file at ${r.filePath}`);
    const all = loadAtoms({ promote: false });
    assert.equal(all.length, 1);
    assert.ok(all[0].tags.includes(DEMO_SEED_TAG));
    // Atom must be approved so retrieval can hit it without the 24h
    // pending wait that real escalation atoms go through.
    assert.equal(all[0].status, "approved");
    // Question is consistent so the suggested smoke-test prompt
    // ("DM the bot with ...") matches what gets retrieved.
    assert.equal(all[0].question, r.question);
  });

  it("is idempotent: second call doesn't duplicate", () => {
    const first = seedDemoAtom();
    const second = seedDemoAtom();
    assert.equal(first.written, true);
    assert.equal(second.written, false);
    assert.equal(first.atomId, second.atomId);
    const all = loadAtoms({ promote: false });
    assert.equal(all.length, 1);
  });

  it("answer body contains the smoke-test instructions", () => {
    seedDemoAtom();
    const all = loadAtoms({ promote: false });
    assert.match(all[0].answer, /demo seed/);
    assert.match(all[0].answer, /demo unseed/);
  });
});

describe("demo-seed — unseedDemoAtoms (FR4)", () => {
  it("removes the seeded atom", () => {
    seedDemoAtom();
    assert.equal(loadAtoms({ promote: false }).length, 1);
    const r = unseedDemoAtoms();
    assert.equal(r.removed.length, 1);
    assert.equal(loadAtoms({ promote: false }).length, 0);
  });

  it("is idempotent: no demo atom → empty removed list, no throw", () => {
    const r = unseedDemoAtoms();
    assert.deepEqual(r.removed, []);
  });

  it("leaves untagged atoms untouched", () => {
    const realAtom: KnowledgeAtom = {
      id: "real-atom-fixture-1",
      createdAt: Date.now(),
      scope: "general",
      question: "Real production atom?",
      answer: "Yes, definitely real.",
      tags: ["pmk", "ops"],
      source: { threadKey: "C1:1700.000001", contributorUserId: "Ureal" },
      status: "approved",
    };
    saveAtom(realAtom);
    seedDemoAtom();
    assert.equal(loadAtoms({ promote: false }).length, 2);

    const r = unseedDemoAtoms();
    assert.equal(r.removed.length, 1);

    const remaining = loadAtoms({ promote: false });
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, "real-atom-fixture-1");
    assert.equal(remaining[0].question, "Real production atom?");
  });

  it("removes multiple demo atoms if somehow more than one exists", () => {
    // Manually plant a second demo-tagged atom to simulate a race /
    // hand-edited atom — unseed should clean both.
    seedDemoAtom();
    const second: KnowledgeAtom = {
      id: "demo-seed-manual-extra",
      createdAt: Date.now() + 1,
      scope: "general",
      question: "extra demo q",
      answer: "extra demo a",
      tags: [DEMO_SEED_TAG, "extra"],
      source: { threadKey: "demo:extra", contributorUserId: "DEMO" },
      status: "approved",
    };
    saveAtom(second);
    assert.equal(loadAtoms({ promote: false }).length, 2);
    const r = unseedDemoAtoms();
    assert.equal(r.removed.length, 2);
    assert.equal(loadAtoms({ promote: false }).length, 0);
  });
});

describe("demo-seed — findDemoAtoms", () => {
  it("returns [] when no atoms exist at all", () => {
    assert.deepEqual(findDemoAtoms(), []);
  });

  it("returns [] when only untagged atoms exist", () => {
    const realAtom: KnowledgeAtom = {
      id: "real-only-fixture",
      createdAt: Date.now(),
      scope: "general",
      question: "untagged?",
      answer: "untagged.",
      tags: ["foo"],
      source: { threadKey: "C:1", contributorUserId: "U1" },
      status: "approved",
    };
    saveAtom(realAtom);
    assert.deepEqual(findDemoAtoms(), []);
  });

  it("filters by DEMO_SEED_TAG", () => {
    seedDemoAtom();
    const demos = findDemoAtoms();
    assert.equal(demos.length, 1);
    assert.ok(demos[0].tags.includes(DEMO_SEED_TAG));
  });
});
