import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ORIG_HOME = process.env.HOME;

function seedEvent(homeDir: string, atIso: string, payload: object): void {
  const dir = path.join(homeDir, ".pmk", "gateway");
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, "events.log"),
    JSON.stringify({ at: atIso, ...payload }) + "\n",
    "utf8",
  );
}

function seedAtom(
  homeDir: string,
  scope: string,
  slug: string,
  frontMatter: Record<string, unknown>,
  body = "answer body",
): void {
  const dir = path.join(homeDir, ".pmk", "knowledge", scope);
  fs.mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontMatter)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
  fs.writeFileSync(
    path.join(dir, `${slug}.md`),
    `---\n${fm}\n---\n\n${body}\n`,
    "utf8",
  );
}

function seedEscalation(
  homeDir: string,
  channelId: string,
  threadTs: string,
  pendingSinceMs: number,
): void {
  const dir = path.join(homeDir, ".pmk", "gateway", "slack", "escalations");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${channelId}__${threadTs}.json`),
    JSON.stringify({
      channelId,
      threadTs,
      question: "q",
      pendingSince: pendingSinceMs,
      mentionedUserIds: [],
    }),
    "utf8",
  );
}

describe("gateway audit aggregator (#24)", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-gw-audit-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  });

  it("returns an empty-ish report when nothing has been recorded", async () => {
    const { buildAuditReport } = await import("../src/gateway/audit");
    const report = buildAuditReport({ days: 7 });
    assert.equal(report.windowDays, 7);
    assert.equal(report.conversations.totalTurns, 0);
    assert.equal(report.conversations.perUser.length, 0);
    assert.equal(report.conversations.perAudience.length, 0);
    assert.equal(report.mraAsk.invocations, 0);
    assert.equal(report.escalate.triggered, 0);
    assert.equal(report.escalate.pending, 0);
    assert.equal(report.atoms.total, 0);
    assert.deepEqual(report.flags, []);
  });

  it("counts turns per user and per audience from turn.processed events", async () => {
    const recent = new Date().toISOString();
    seedEvent(tmpHome, recent, {
      type: "turn.processed",
      actor: "U_A",
      audience: "tech",
      hadMraAsk: false,
      atomsInjected: 0,
    });
    seedEvent(tmpHome, recent, {
      type: "turn.processed",
      actor: "U_A",
      audience: "tech",
      hadMraAsk: false,
      atomsInjected: 1,
    });
    seedEvent(tmpHome, recent, {
      type: "turn.processed",
      actor: "U_B",
      audience: "biz",
      hadMraAsk: false,
      atomsInjected: 0,
    });
    const { buildAuditReport } = await import("../src/gateway/audit");
    const r = buildAuditReport({ days: 7 });
    assert.equal(r.conversations.totalTurns, 3);
    // perUser sorted by count desc
    assert.deepEqual(r.conversations.perUser, [
      { userId: "U_A", turns: 2 },
      { userId: "U_B", turns: 1 },
    ]);
    assert.deepEqual(r.conversations.perAudience, [
      { audience: "tech", turns: 2 },
      { audience: "biz", turns: 1 },
    ]);
    // retrieval injections come from atomsInjected
    assert.equal(r.atoms.retrievalInjections, 1);
  });

  it("excludes events older than the window", async () => {
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    seedEvent(tmpHome, old, {
      type: "turn.processed",
      actor: "U_OLD",
      audience: "tech",
      hadMraAsk: false,
      atomsInjected: 5,
    });
    seedEvent(tmpHome, recent, {
      type: "turn.processed",
      actor: "U_NEW",
      audience: "tech",
      hadMraAsk: false,
      atomsInjected: 0,
    });
    const { buildAuditReport } = await import("../src/gateway/audit");
    const r = buildAuditReport({ days: 7 });
    assert.equal(r.conversations.totalTurns, 1);
    assert.equal(
      r.conversations.perUser[0].userId,
      "U_NEW",
      "old user should be excluded",
    );
    assert.equal(r.atoms.retrievalInjections, 0, "old injections excluded");
  });

  it("classifies mra-ask outcomes: success / retry-then-success / failure", async () => {
    const at = new Date().toISOString();
    // 2 clean successes
    seedEvent(tmpHome, at, {
      type: "mra-ask.end",
      actor: "U_A",
      repo: "erp",
      ok: true,
      retried: false,
      durationMs: 30_000,
    });
    seedEvent(tmpHome, at, {
      type: "mra-ask.end",
      actor: "U_A",
      repo: "erp",
      ok: true,
      retried: false,
      durationMs: 50_000,
    });
    // 1 retried success
    seedEvent(tmpHome, at, {
      type: "mra-ask.end",
      actor: "U_B",
      repo: "oss-ui-v2",
      ok: true,
      retried: true,
      durationMs: 90_000,
    });
    // 1 failure
    seedEvent(tmpHome, at, {
      type: "mra-ask.end",
      actor: "U_B",
      repo: "erp",
      ok: false,
      retried: true,
      durationMs: 70_000,
    });
    const { buildAuditReport } = await import("../src/gateway/audit");
    const r = buildAuditReport({ days: 7 });
    assert.equal(r.mraAsk.invocations, 4);
    assert.equal(r.mraAsk.successes, 2);
    assert.equal(r.mraAsk.retries, 1);
    assert.equal(r.mraAsk.failures, 1);
    assert.equal(
      r.mraAsk.medianDurationMs,
      60_000,
      "median of [30k, 50k, 70k, 90k] is (50k+70k)/2 = 60k",
    );
    // topRepos sorted desc, ties stable
    assert.deepEqual(r.mraAsk.topRepos, [
      { repo: "erp", count: 3 },
      { repo: "oss-ui-v2", count: 1 },
    ]);
  });

  it("pairs escalate.triggered with escalate.absorbed by (channelId, threadTs) for time-to-reply", async () => {
    const triggeredAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    const absorbedAt = new Date().toISOString();
    seedEvent(tmpHome, triggeredAt, {
      type: "escalate.triggered",
      channelId: "C0X",
      threadTs: "100.0",
      scope: "erp",
    });
    seedEvent(tmpHome, absorbedAt, {
      type: "escalate.absorbed",
      channelId: "C0X",
      threadTs: "100.0",
      atomId: "atom-1",
    });
    // an unmatched trigger (no absorb yet)
    seedEvent(tmpHome, new Date().toISOString(), {
      type: "escalate.triggered",
      channelId: "C0X",
      threadTs: "200.0",
    });
    // pending marker on disk
    seedEscalation(tmpHome, "C0X", "200.0", Date.now());
    const { buildAuditReport } = await import("../src/gateway/audit");
    const r = buildAuditReport({ days: 7 });
    assert.equal(r.escalate.triggered, 2);
    assert.equal(r.escalate.absorbed, 1);
    assert.equal(r.escalate.pending, 1);
    assert.ok(
      r.escalate.medianTimeToReplyMs !== undefined &&
        r.escalate.medianTimeToReplyMs >= 50 * 60 * 1000 &&
        r.escalate.medianTimeToReplyMs <= 70 * 60 * 1000,
      `expected ~1h, got ${r.escalate.medianTimeToReplyMs}`,
    );
  });

  it("re-triggered same thread: absorption pairs FIFO with the oldest unmatched trigger", async () => {
    // Same Slack thread escalated twice (first round ignored, user
    // re-asks, pmk re-escalates), then absorbed once. The absorption
    // should pair with the FIRST trigger so median time-to-reply
    // reflects "from when the original question was asked".
    const t1 = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(); // 4h ago
    const t2 = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
    const t3 = new Date().toISOString(); // now
    seedEvent(tmpHome, t1, {
      type: "escalate.triggered",
      channelId: "C0X",
      threadTs: "999.0",
    });
    seedEvent(tmpHome, t2, {
      type: "escalate.triggered",
      channelId: "C0X",
      threadTs: "999.0",
    });
    seedEvent(tmpHome, t3, {
      type: "escalate.absorbed",
      channelId: "C0X",
      threadTs: "999.0",
      atomId: "atom-x",
    });
    const { buildAuditReport } = await import("../src/gateway/audit");
    const r = buildAuditReport({ days: 7 });
    assert.equal(r.escalate.triggered, 2);
    assert.equal(r.escalate.absorbed, 1);
    assert.ok(
      r.escalate.medianTimeToReplyMs !== undefined &&
        r.escalate.medianTimeToReplyMs >= 3.5 * 60 * 60 * 1000,
      `expected pairing with t1 (~4h), got ${r.escalate.medianTimeToReplyMs}ms`,
    );
  });

  it("counts atoms by status and surfaces top contributors (lifetime, not window)", async () => {
    const now = Date.now();
    // 3 approved by U_IT1, 2 approved by U_IT2, 1 pending by U_IT3
    seedAtom(tmpHome, "erp", "q1", {
      id: "a1",
      createdAt: now - 5_000,
      scope: "erp",
      question: "q1",
      tags: [],
      status: "approved",
      source: { threadKey: "C:1", contributorUserId: "U_IT1" },
    });
    seedAtom(tmpHome, "erp", "q2", {
      id: "a2",
      createdAt: now - 4_000,
      scope: "erp",
      question: "q2",
      tags: [],
      status: "approved",
      source: { threadKey: "C:2", contributorUserId: "U_IT1" },
    });
    seedAtom(tmpHome, "erp", "q3", {
      id: "a3",
      createdAt: now - 3_000,
      scope: "erp",
      question: "q3",
      tags: [],
      status: "approved",
      source: { threadKey: "C:3", contributorUserId: "U_IT1" },
    });
    seedAtom(tmpHome, "general", "q4", {
      id: "a4",
      createdAt: now - 2_000,
      scope: "general",
      question: "q4",
      tags: [],
      status: "approved",
      source: { threadKey: "C:4", contributorUserId: "U_IT2" },
    });
    seedAtom(tmpHome, "general", "q5", {
      id: "a5",
      createdAt: now - 1_000,
      scope: "general",
      question: "q5",
      tags: [],
      status: "approved",
      source: { threadKey: "C:5", contributorUserId: "U_IT2" },
    });
    seedAtom(tmpHome, "erp", "q6", {
      id: "a6",
      createdAt: now,
      scope: "erp",
      question: "q6",
      tags: [],
      status: "pending",
      expiresAt: now + 24 * 60 * 60 * 1000,
      source: { threadKey: "C:6", contributorUserId: "U_IT3" },
    });
    const { buildAuditReport } = await import("../src/gateway/audit");
    const r = buildAuditReport({ days: 7 });
    assert.equal(r.atoms.total, 6);
    assert.equal(r.atoms.approved, 5);
    assert.equal(r.atoms.pending, 1);
    assert.deepEqual(r.atoms.topContributors, [
      { userId: "U_IT1", count: 3 },
      { userId: "U_IT2", count: 2 },
      { userId: "U_IT3", count: 1 },
    ]);
  });

  it("median atoms-injected per turn ignores zero-injection turns when computing the rate, but reports it as undefined when no injections happened", async () => {
    const at = new Date().toISOString();
    // turns with injections: 1, 2, 3
    seedEvent(tmpHome, at, {
      type: "turn.processed",
      actor: "U",
      audience: "tech",
      hadMraAsk: false,
      atomsInjected: 1,
    });
    seedEvent(tmpHome, at, {
      type: "turn.processed",
      actor: "U",
      audience: "tech",
      hadMraAsk: false,
      atomsInjected: 2,
    });
    seedEvent(tmpHome, at, {
      type: "turn.processed",
      actor: "U",
      audience: "tech",
      hadMraAsk: false,
      atomsInjected: 3,
    });
    // a no-injection turn — counts toward totalTurns but excluded from median
    seedEvent(tmpHome, at, {
      type: "turn.processed",
      actor: "U",
      audience: "tech",
      hadMraAsk: false,
      atomsInjected: 0,
    });
    const { buildAuditReport } = await import("../src/gateway/audit");
    const r = buildAuditReport({ days: 7 });
    assert.equal(r.conversations.totalTurns, 4);
    assert.equal(r.atoms.retrievalInjections, 6);
    assert.equal(r.atoms.medianAtomsInjectedPerTurn, 2);
  });

  it("does not auto-promote TTL-expired pending atoms (audit is read-only)", async () => {
    // Pending atom whose expiresAt is already in the past. Without
    // {promote: false} loadAtoms would silently rewrite it to
    // approved at the moment of audit. The on-disk file must remain
    // pending after running the audit.
    const now = Date.now();
    seedAtom(tmpHome, "erp", "expired", {
      id: "expired",
      createdAt: now - 30 * 60 * 60 * 1000,
      scope: "erp",
      question: "expired",
      tags: [],
      status: "pending",
      expiresAt: now - 60 * 60 * 1000, // TTL passed an hour ago
      source: { threadKey: "C:1", contributorUserId: "U_IT" },
    });
    const { buildAuditReport } = await import("../src/gateway/audit");
    const r = buildAuditReport({ days: 7 });
    assert.equal(r.atoms.pending, 1, "still pending in the report");
    assert.equal(r.atoms.approved, 0);
    // Verify the file on disk wasn't rewritten by the audit.
    const file = path.join(tmpHome, ".pmk/knowledge/erp/expired.md");
    const raw = fs.readFileSync(file, "utf8");
    assert.match(raw, /status: pending/);
  });

  it("flags pending atoms older than 24h and pending escalations older than 48h", async () => {
    const now = Date.now();
    // pending atom created > 24h ago, expiresAt also passed but loadAtoms
    // would have promoted it. To exercise the flag path we need a
    // pending-and-still-pending state — simulate the bug by writing a
    // pending atom with expiresAt > now (auto-promote hasn't fired yet)
    // but createdAt > 24h ago, which means the gateway should have
    // restarted by now.
    seedAtom(tmpHome, "erp", "stuck", {
      id: "stuck",
      createdAt: now - 30 * 60 * 60 * 1000, // 30h ago
      scope: "erp",
      question: "stuck",
      tags: [],
      status: "pending",
      expiresAt: now + 60 * 60 * 1000, // still pending in the future
      source: { threadKey: "C:1", contributorUserId: "U_IT" },
    });
    // pending escalation > 48h
    seedEscalation(tmpHome, "C0X", "999.0", now - 50 * 60 * 60 * 1000);
    const { buildAuditReport } = await import("../src/gateway/audit");
    const r = buildAuditReport({ days: 7 });
    assert.ok(
      r.flags.some((f) => /atom/i.test(f) && /24h/.test(f)),
      `expected an atom-stuck flag, got: ${JSON.stringify(r.flags)}`,
    );
    assert.ok(
      r.flags.some((f) => /escalate/i.test(f) && /48h/.test(f)),
      `expected an escalate-stale flag, got: ${JSON.stringify(r.flags)}`,
    );
  });

  it("contextSafety counts the new context.* and message.capped events", async () => {
    const at = new Date().toISOString();
    seedEvent(tmpHome, at, {
      type: "context.exceeded",
      actor: "Uabc",
      sessionTokensBefore: 30000,
      retrievalAtoms: 1,
      phase: "first-call",
    });
    seedEvent(tmpHome, at, {
      type: "context.exceeded",
      actor: "Udef",
      sessionTokensBefore: 28000,
      retrievalAtoms: 0,
      phase: "synthesise",
    });
    seedEvent(tmpHome, at, {
      type: "context.force-pruned",
      actor: "Uabc",
      droppedPairs: 4,
      tokensAfter: 1200,
    });
    seedEvent(tmpHome, at, {
      type: "context.force-pruned",
      actor: "Udef",
      droppedPairs: 3,
      tokensAfter: 1500,
    });
    seedEvent(tmpHome, at, {
      type: "message.capped",
      actor: "Uabc",
      kind: "seed",
      originalChars: 88292,
      cappedChars: 12000,
    });
    seedEvent(tmpHome, at, {
      type: "message.capped",
      actor: "Uabc",
      kind: "seed",
      originalChars: 70000,
      cappedChars: 12000,
    });
    seedEvent(tmpHome, at, {
      type: "message.capped",
      actor: "Udef",
      kind: "mra-result",
      originalChars: 30000,
      cappedChars: 16000,
    });
    const { buildAuditReport } = await import("../src/gateway/audit");
    const report = buildAuditReport({ days: 30 });
    assert.deepEqual(report.contextSafety, {
      contextExceeded: { total: 2, firstCall: 1, synthesise: 1 },
      contextForcePruned: 2,
      messageCapped: { total: 3, seed: 2, mraResult: 1 },
    });
  });

  it("days option must be a positive integer; bad input falls back to 7", async () => {
    const { buildAuditReport } = await import("../src/gateway/audit");
    assert.equal(buildAuditReport({ days: 0 }).windowDays, 7);
    assert.equal(buildAuditReport({ days: -3 }).windowDays, 7);
    assert.equal(buildAuditReport({ days: NaN }).windowDays, 7);
    assert.equal(buildAuditReport({ days: 14 }).windowDays, 14);
  });

  it("tokenUsage aggregates token.usage events (T7 / v0.12.0)", async () => {
    const { appendGatewayEvent } = await import("../src/gateway/events");
    const { buildAuditReport } = await import("../src/gateway/audit");
    const now = Date.now();
    appendGatewayEvent({
      type: "token.usage",
      actor: "Uabc",
      provider: "anthropic-api",
      model: "claude-sonnet-4-6",
      inputTokens: 1000,
      outputTokens: 100,
    });
    appendGatewayEvent({
      type: "token.usage",
      actor: "Uabc",
      provider: "anthropic-api",
      model: "claude-sonnet-4-6",
      inputTokens: 2000,
      outputTokens: 200,
      cacheReadTokens: 500,
    });
    appendGatewayEvent({
      type: "token.usage",
      actor: "Udef",
      provider: "anthropic-api",
      model: "claude-sonnet-4-6",
      inputTokens: 3000,
      outputTokens: 300,
    });

    const report = buildAuditReport({ days: 30, nowMs: now });
    assert.equal(report.tokenUsage.total.inputTokens, 6000);
    assert.equal(report.tokenUsage.total.outputTokens, 600);
    assert.equal(report.tokenUsage.total.cacheReadTokens, 500);
    assert.equal(report.tokenUsage.total.cacheCreationTokens, 0);

    // Per-actor: both Uabc and Udef have inputTokens=3000 — order between
    // them is implementation-defined for ties (stable sort + Map insertion
    // order), so assert order-agnostically.
    const top = report.tokenUsage.perActor;
    assert.equal(top.length, 2);
    const byActor = Object.fromEntries(top.map((t) => [t.actor, t]));
    assert.equal(byActor.Uabc.inputTokens, 3000);
    assert.equal(byActor.Uabc.outputTokens, 300);
    assert.equal(byActor.Udef.inputTokens, 3000);
    assert.equal(byActor.Udef.outputTokens, 300);

    assert.equal(report.tokenUsage.perModel.length, 1);
    assert.equal(report.tokenUsage.perModel[0].model, "claude-sonnet-4-6");
    assert.equal(report.tokenUsage.perModel[0].inputTokens, 6000);
    assert.equal(report.tokenUsage.perModel[0].outputTokens, 600);
  });
});
