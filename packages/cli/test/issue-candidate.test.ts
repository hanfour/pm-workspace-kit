import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  saveIssueCandidate,
  loadIssueCandidate,
  claimIssueCandidate,
  releaseIssueCandidate,
  finalizeIssueCandidate,
  recoverIssueClaims,
  issueCandidatePath,
  type IssueCandidate,
} from "../src/gateway/issue-candidate";

const sample = (over: Partial<IssueCandidate> = {}): IssueCandidate => ({
  channelId: "C1",
  threadTs: "100.1",
  anchorTs: "100.2",
  scope: "erp",
  askerUserId: "U-ASK",
  mentionedUserIds: ["U-IT"],
  question: "why broken",
  diagnosis: "root cause at a.rb:10",
  ...over,
});

describe("issue-candidate store", () => {
  let home: string;
  const orig = process.env.HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-issue-cand-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    if (orig !== undefined) process.env.HOME = orig;
  });

  it("save round-trips and writes mode 0600", () => {
    const c = sample();
    saveIssueCandidate(c);
    assert.deepEqual(loadIssueCandidate("C1", "100.2"), c);
    const mode = fs.statSync(issueCandidatePath("C1", "100.2")).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it("load distinguishes corrupt (logs) from missing (silent)", () => {
    assert.equal(loadIssueCandidate("C1", "nope"), undefined); // missing → no log
    saveIssueCandidate(sample());
    fs.writeFileSync(issueCandidatePath("C1", "100.2"), "{ not json");
    const logs: string[] = [];
    assert.equal(loadIssueCandidate("C1", "100.2", (m) => logs.push(m)), undefined);
    assert.equal(logs.length, 1); // corrupt → logged once
  });

  it("claim is atomic: a second claim returns undefined", () => {
    saveIssueCandidate(sample());
    const first = claimIssueCandidate("C1", "100.2");
    assert.ok(first);
    assert.equal(first?.scope, "erp");
    const second = claimIssueCandidate("C1", "100.2");
    assert.equal(second, undefined);
  });

  it("release puts the record back so a later claim works", () => {
    saveIssueCandidate(sample());
    assert.ok(claimIssueCandidate("C1", "100.2"));
    assert.equal(releaseIssueCandidate("C1", "100.2"), true);
    assert.ok(claimIssueCandidate("C1", "100.2"));
  });

  it("finalize writes the url and commits to .json", () => {
    saveIssueCandidate(sample());
    assert.ok(claimIssueCandidate("C1", "100.2"));
    finalizeIssueCandidate("C1", "100.2", "https://github.com/o/r/issues/9");
    const after = loadIssueCandidate("C1", "100.2");
    assert.equal(after?.issuedUrl, "https://github.com/o/r/issues/9");
    assert.ok(!fs.existsSync(issueCandidatePath("C1", "100.2") + ".claiming"));
  });

  it("recover finalizes a .claiming that already has issuedUrl; warns on a bare one", () => {
    saveIssueCandidate(sample({ anchorTs: "100.3", issuedUrl: "https://x/1" }));
    const cp = issueCandidatePath("C1", "100.3");
    fs.renameSync(cp, cp + ".claiming");
    saveIssueCandidate(sample({ anchorTs: "100.4" }));
    const bp = issueCandidatePath("C1", "100.4");
    fs.renameSync(bp, bp + ".claiming");

    const warnings: string[] = [];
    recoverIssueClaims(0, (m) => warnings.push(m)); // staleMs=0 → bare one is stale
    assert.ok(fs.existsSync(cp)); // finalized
    assert.equal(warnings.length, 1); // only the bare one warns
  });
});
