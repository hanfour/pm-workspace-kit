import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Never point HOME back at the operator's home. Test files run in separate
// processes, so restoring buys nothing — and it opens a window that has
// already caused an outage: a cancelled test's abandoned continuation resumes
// AFTER afterEach, sees the real HOME, and writes to the live ~/.pmk. On
// 2026-08-04 that overwrote the gateway config with test fixtures and took
// the bot down. ORIG_HOME is a throwaway directory, never the real one.
const ORIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-safe-home-"));
process.env.HOME = ORIG_HOME;

describe("acme-ads-seed", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-acme-"));
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env.HOME = ORIG_HOME;
  });

  it("seeds exactly 5 approved atoms tagged acme-ads-demo, scope acme-ads", async () => {
    const { seedAcmeAdsAtoms, ACME_ADS_SEED_TAG } = await import("../src/gateway/acme-ads-seed");
    const { loadAtoms } = await import("../src/gateway/knowledge");
    const res = seedAcmeAdsAtoms();
    assert.equal(res.atomIds.length, 5);
    assert.equal(res.alreadyPresent, false);
    const atoms = loadAtoms({ scope: "acme-ads", promote: false });
    assert.equal(atoms.length, 5);
    for (const a of atoms) {
      assert.equal(a.status, "approved");
      assert.equal(a.scope, "acme-ads");
      assert.ok(a.tags.includes(ACME_ADS_SEED_TAG));
    }
  });

  it("re-seeding is idempotent (still 5, alreadyPresent true)", async () => {
    const { seedAcmeAdsAtoms } = await import("../src/gateway/acme-ads-seed");
    const { loadAtoms } = await import("../src/gateway/knowledge");
    seedAcmeAdsAtoms();
    const second = seedAcmeAdsAtoms();
    assert.equal(second.alreadyPresent, true);
    assert.equal(loadAtoms({ scope: "acme-ads", promote: false }).length, 5);
  });

  it("unseed removes only acme-ads-demo atoms, leaves others", async () => {
    const { seedAcmeAdsAtoms, unseedAcmeAdsAtoms } = await import("../src/gateway/acme-ads-seed");
    const { saveAtom, loadAtoms } = await import("../src/gateway/knowledge");
    saveAtom({
      id: "keep-me-1", createdAt: 1, scope: "general", question: "q", answer: "a",
      tags: ["something-else"], source: { threadKey: "t", contributorUserId: "U" }, status: "approved",
    });
    seedAcmeAdsAtoms();
    const removed = unseedAcmeAdsAtoms();
    assert.equal(removed.removedIds.length, 5);
    const left = loadAtoms({ promote: false });
    assert.equal(left.length, 1);
    assert.equal(left[0].id, "keep-me-1");
  });

  it("each atom has a non-empty question/answer/summary", async () => {
    const { seedAcmeAdsAtoms } = await import("../src/gateway/acme-ads-seed");
    const { loadAtoms } = await import("../src/gateway/knowledge");
    seedAcmeAdsAtoms();
    for (const a of loadAtoms({ scope: "acme-ads", promote: false })) {
      assert.ok(a.question.length > 0);
      assert.ok(a.answer.length > 0);
      assert.ok((a.summary ?? "").length > 0);
    }
  });
});
