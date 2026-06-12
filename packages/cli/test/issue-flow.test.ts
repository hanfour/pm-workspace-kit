import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { buildHarness, reactionAddedPayload } from "./harness/slack-fakes";
import { saveIssueCandidate, loadIssueCandidate, issueCandidatePath } from "../src/gateway/issue-candidate";
import { readGatewayEvents } from "../src/gateway/events";

function fakeGithub(over: Record<string, unknown> = {}) {
  return {
    findGhBinary: () => "/usr/bin/gh",
    resolveRepoSlug: async () => "onead/erp",
    repoVisibility: async () => "private",
    createIssue: async () => "https://github.com/onead/erp/issues/5",
    ...over,
  };
}

const seedCandidate = (anchorTs: string, over = {}) =>
  saveIssueCandidate({
    channelId: "C1", threadTs: "100.1", anchorTs, scope: "erp",
    askerUserId: "U-ASK", mentionedUserIds: ["U-IT"],
    question: "why broken", diagnosis: "root cause a.rb:10", ...over,
  });

describe("🎫 issue flow", () => {
  let h: ReturnType<typeof buildHarness>;
  afterEach(() => h?.cleanup());

  async function react(anchorTs: string, user = "U-IT", reaction = "ticket") {
    await h.socket.emit("reaction_added",
      reactionAddedPayload({ user, reaction, itemChannel: "C1", itemTs: anchorTs }));
    await h.flush();
  }

  it("authorized 🎫 creates the issue from the snapshot, finalizes, audits", async () => {
    h = buildHarness({ github: fakeGithub() });
    seedCandidate("200.1");
    await h.adapter.start();
    await react("200.1");
    assert.equal(loadIssueCandidate("C1", "200.1")?.issuedUrl, "https://github.com/onead/erp/issues/5");
    assert.ok(readGatewayEvents().find((e) => e.type === "github.issue.created"));
  });

  it("reply-first then 🎫 still works (durable candidate survives)", async () => {
    h = buildHarness({ github: fakeGithub() });
    seedCandidate("200.2");
    await h.adapter.start();
    await react("200.2");
    assert.ok(loadIssueCandidate("C1", "200.2")?.issuedUrl);
  });

  it("createIssue failure does NOT release (.claiming stays); second 🎫 no duplicate", async () => {
    let calls = 0;
    h = buildHarness({ github: fakeGithub({ createIssue: async () => { calls += 1; throw new Error("gh issue create failed (1)"); } }) });
    seedCandidate("200.3");
    await h.adapter.start();
    await react("200.3");
    assert.ok(fs.existsSync(issueCandidatePath("C1", "200.3") + ".claiming"));
    await react("200.3");
    assert.equal(calls, 1);
  });

  it("missing gh → reason=no-gh, claim released, repoVisibility/createIssue NOT called", async () => {
    let visCalled = false;
    h = buildHarness({ github: fakeGithub({ findGhBinary: () => undefined, repoVisibility: async () => { visCalled = true; return "private"; } }) });
    seedCandidate("200.4");
    await h.adapter.start();
    await react("200.4");
    assert.equal(visCalled, false);
    assert.equal(fs.existsSync(issueCandidatePath("C1", "200.4") + ".claiming"), false);
    const ev = readGatewayEvents().find((e) => e.type === "github.issue.failed");
    assert.equal((ev as { reason?: string })?.reason, "no-gh");
  });

  it("public repo (allowPublicRepos default false) → blocked, released, reason=public-repo", async () => {
    h = buildHarness({ github: fakeGithub({ repoVisibility: async () => "public" }) });
    seedCandidate("200.5");
    await h.adapter.start();
    await react("200.5");
    assert.equal(loadIssueCandidate("C1", "200.5")?.issuedUrl, undefined);
    const ev = readGatewayEvents().find((e) => e.type === "github.issue.failed");
    assert.equal((ev as { reason?: string })?.reason, "public-repo");
  });

  it("unauthorized reactor (not in mentionedUserIds) is ignored", async () => {
    let created = false;
    h = buildHarness({ github: fakeGithub({ createIssue: async () => { created = true; return "x"; } }) });
    seedCandidate("200.6");
    await h.adapter.start();
    await react("200.6", "U-RANDO");
    assert.equal(created, false);
  });

  it("duplicate 🎫 after issued → existing URL, createIssue not called again", async () => {
    let calls = 0;
    h = buildHarness({ github: fakeGithub({ createIssue: async () => { calls += 1; return "https://github.com/onead/erp/issues/9"; } }) });
    seedCandidate("200.7");
    await h.adapter.start();
    await react("200.7");
    await react("200.7");
    assert.equal(calls, 1);
  });

  it("no mraWorkspace configured → slug failure, createIssue not called", async () => {
    let created = false;
    // defaultGatewayConfig now sets mraWorkspace for other tests; override to undefined here
    // to exercise the explicit guard that short-circuits before calling resolveRepoSlug
    h = buildHarness({ config: { mraWorkspace: undefined }, github: fakeGithub({ createIssue: async () => { created = true; return "x"; } }) });
    seedCandidate("200.8");
    await h.adapter.start();
    await react("200.8");
    assert.equal(created, false);
    const ev = readGatewayEvents().find((e) => e.type === "github.issue.failed");
    assert.equal((ev as { reason?: string })?.reason, "slug");
  });

  it("🎫 with no candidate is ignored", async () => {
    h = buildHarness({ github: fakeGithub() });
    await h.adapter.start();
    await react("999.9");
    const githubEvents = readGatewayEvents().filter((e) =>
      e.type === "github.issue.created" || e.type === "github.issue.failed"
    );
    assert.equal(githubEvents.length, 0);
  });
});
