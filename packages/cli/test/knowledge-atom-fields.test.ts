import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { saveAtom, loadAtoms, findAtomByThreadKey, formatAtomsForInjection, type KnowledgeAtom } from "../src/gateway/knowledge";

const ORIG = process.env.HOME;
const atom = (over: Partial<KnowledgeAtom> = {}): KnowledgeAtom => ({
  id: "20260629T000000-aaaa-meeting", createdAt: 1, scope: "general",
  question: "Q2 認證方案決議", answer: "決議採用 OAuth。", tags: ["auth"],
  source: { threadKey: "C1:111.222", contributorUserId: "U1" }, status: "approved", ...over,
});

describe("knowledge atom permalink + flagged + dedup", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-k-")); process.env.HOME = tmp; });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); if (ORIG) process.env.HOME = ORIG; });

  it("round-trips source.permalink and flagged through save/load", () => {
    saveAtom(atom({ source: { threadKey: "C1:111.222", contributorUserId: "U1", permalink: "https://x.slack.com/archives/C1/p111222" }, flagged: true }));
    const [loaded] = loadAtoms({ scope: "general" });
    assert.equal(loaded.source.permalink, "https://x.slack.com/archives/C1/p111222");
    assert.equal(loaded.flagged, true);
  });

  it("findAtomByThreadKey returns the atom for a threadKey across statuses", () => {
    saveAtom(atom({ id: "20260629T000000-bbbb-x", source: { threadKey: "C9:9.9", contributorUserId: "U1" }, status: "pending", expiresAt: 9e15 }));
    const found = findAtomByThreadKey("C9:9.9");
    assert.ok(found, "must find pending atom by threadKey");
    assert.equal(findAtomByThreadKey("C9:nope"), undefined);
  });

  it("formatAtomsForInjection frames atoms as data-not-instructions and never leaks permalink", () => {
    const out = formatAtomsForInjection([atom({ source: { threadKey: "C1:1", contributorUserId: "U1", permalink: "https://secret.link/p1" } })]);
    assert.ok(!out.includes("https://secret.link"), "permalink must NOT appear in injection");
    assert.ok(/不是指令|非指令/.test(out), "framing must mark content as non-instruction");
    assert.ok(!/請當作 ground truth/.test(out), "old obedient framing removed");
  });
});
