import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  formatAuditReport,
  formatDurationMs,
} from "../src/gateway/audit-format";
import type { AuditReport } from "../src/gateway/audit";

const NOW = Date.parse("2026-04-29T12:00:00.000Z");

function emptyReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    windowDays: 7,
    windowStartMs: NOW - 7 * 86_400_000,
    windowEndMs: NOW,
    conversations: { totalTurns: 0, perUser: [], perAudience: [] },
    mraAsk: {
      invocations: 0,
      successes: 0,
      retries: 0,
      failures: 0,
      medianDurationMs: undefined,
      topRepos: [],
    },
    escalate: {
      triggered: 0,
      absorbed: 0,
      pending: 0,
      medianTimeToReplyMs: undefined,
    },
    atoms: {
      total: 0,
      approved: 0,
      pending: 0,
      retrievalInjections: 0,
      medianAtomsInjectedPerTurn: undefined,
      topContributors: [],
    },
    contextSafety: {
      contextExceeded: { total: 0, firstCall: 0, synthesise: 0 },
      contextForcePruned: 0,
      messageCapped: { total: 0, seed: 0, mraResult: 0 },
    },
    flags: [],
    ...overrides,
  };
}

describe("formatDurationMs", () => {
  it("seconds for sub-minute", () => {
    assert.equal(formatDurationMs(42_000), "42s");
    assert.equal(formatDurationMs(900), "1s"); // round up sub-second
  });
  it("minutes for sub-hour", () => {
    assert.equal(formatDurationMs(60_000), "1m");
    assert.equal(formatDurationMs(83 * 60_000), "1h 23m");
  });
  it("hours and minutes for sub-day", () => {
    assert.equal(formatDurationMs(2 * 60 * 60_000), "2h");
    assert.equal(formatDurationMs((2 * 60 + 5) * 60_000), "2h 5m");
  });
  it("days and hours for >= 24h", () => {
    assert.equal(formatDurationMs(28 * 60 * 60_000), "1d 4h");
  });
  it("undefined renders as a dash", () => {
    assert.equal(formatDurationMs(undefined), "—");
  });
});

describe("formatAuditReport", () => {
  it("renders the empty case with all zero counts and no flags", () => {
    const out = stripAnsi(formatAuditReport(emptyReport()));
    assert.match(out, /pmk gateway audit \(last 7 days\)/);
    assert.match(out, /total turns:\s+0/);
    assert.match(out, /invocations:\s+0/);
    assert.match(out, /total:\s+0 \(0 approved, 0 pending\)/);
    assert.doesNotMatch(out, /flags/i);
  });

  it("renders per-user / per-audience breakdowns and clips long per-user lists", () => {
    const report = emptyReport({
      conversations: {
        totalTurns: 247,
        perUser: [
          { userId: "U0X", turns: 89 },
          { userId: "U0Y", turns: 41 },
          { userId: "U0Z", turns: 38 },
          { userId: "U0A", turns: 30 },
          { userId: "U0B", turns: 25 },
          { userId: "U0C", turns: 24 },
        ],
        perAudience: [
          { audience: "tech", turns: 142 },
          { audience: "biz", turns: 79 },
          { audience: "exec", turns: 26 },
        ],
      },
    });
    const out = stripAnsi(formatAuditReport(report));
    assert.match(out, /total turns:\s+247/);
    assert.match(out, /U0X 89/);
    assert.match(out, /U0Y 41/);
    assert.match(out, /U0Z 38/);
    // 4th+ users collapsed: ×3 = 79
    assert.match(out, /U_OTHER ×3 = 79/);
    assert.match(out, /tech 142/);
  });

  it("renders mra-ask with percentage of turns and median duration", () => {
    const report = emptyReport({
      conversations: {
        totalTurns: 100,
        perUser: [{ userId: "U", turns: 100 }],
        perAudience: [{ audience: "tech", turns: 100 }],
      },
      mraAsk: {
        invocations: 25,
        successes: 22,
        retries: 2,
        failures: 1,
        medianDurationMs: 42_000,
        topRepos: [
          { repo: "erp", count: 20 },
          { repo: "oss-ui-v2", count: 5 },
        ],
      },
    });
    const out = stripAnsi(formatAuditReport(report));
    assert.match(out, /invocations:\s+25 \(25\.0% of turns\)/);
    assert.match(out, /successes \/ retries \/ fails:\s+22 \/ 2 \/ 1/);
    assert.match(out, /median duration:\s+42s/);
    assert.match(out, /erp ×20.*oss-ui-v2 ×5/);
  });

  it("renders escalate with paired time-to-reply and pending count", () => {
    const report = emptyReport({
      escalate: {
        triggered: 8,
        absorbed: 6,
        pending: 2,
        medianTimeToReplyMs: 83 * 60_000,
      },
    });
    const out = stripAnsi(formatAuditReport(report));
    assert.match(out, /triggered:\s+8/);
    assert.match(out, /absorbed \(atom landed\):\s+6/);
    assert.match(out, /pending \(no reply yet\):\s+2/);
    assert.match(out, /median time-to-IT-reply:\s+1h 23m/);
  });

  it("renders atoms with retrieval injection rate and top contributors", () => {
    const report = emptyReport({
      conversations: {
        totalTurns: 247,
        perUser: [{ userId: "U", turns: 247 }],
        perAudience: [{ audience: "tech", turns: 247 }],
      },
      atoms: {
        total: 42,
        approved: 38,
        pending: 4,
        retrievalInjections: 61,
        medianAtomsInjectedPerTurn: 1.3,
        topContributors: [
          { userId: "U_IT1", count: 11 },
          { userId: "U_IT2", count: 8 },
          { userId: "U_IT3", count: 5 },
        ],
      },
    });
    const out = stripAnsi(formatAuditReport(report));
    assert.match(out, /total:\s+42 \(38 approved, 4 pending\)/);
    assert.match(out, /retrieval injections:\s+61 \(0\.25 atoms\/turn\)/);
    assert.match(out, /median atoms-injected\/turn:\s+1\.3/);
    assert.match(out, /U_IT1 ×11.*U_IT2 ×8.*U_IT3 ×5/);
  });

  it("renders Context safety section with non-zero counts", () => {
    const report = emptyReport();
    report.contextSafety = {
      contextExceeded: { total: 2, firstCall: 1, synthesise: 1 },
      contextForcePruned: 2,
      messageCapped: { total: 3, seed: 2, mraResult: 1 },
    };
    const out = stripAnsi(formatAuditReport(report));
    assert.match(out, /Context safety/);
    assert.match(out, /context\.exceeded:\s+2 \(first-call 1, synthesise 1\)/);
    assert.match(out, /force-pruned:\s+2/);
    assert.match(out, /messages capped:\s+3 \(seed 2, mra-result 1\)/);
  });

  it("renders Context safety section with zero counts (always shown)", () => {
    const report = emptyReport(); // contextSafety already zero from emptyReport helper
    const out = stripAnsi(formatAuditReport(report));
    assert.match(out, /Context safety/);
    assert.match(out, /context\.exceeded:\s+0 \(first-call 0, synthesise 0\)/);
    assert.match(out, /force-pruned:\s+0/);
    assert.match(out, /messages capped:\s+0 \(seed 0, mra-result 0\)/);
  });

  it("renders flags section only when there are flags", () => {
    const report = emptyReport({
      flags: [
        "2 atom(s) have been pending > 24h (auto-promote stuck — gateway not restarted?)",
        "1 escalate(s) with no IT reply for > 48h — consider rejecting marker",
      ],
    });
    const out = stripAnsi(formatAuditReport(report));
    assert.match(out, /flags/);
    assert.match(out, /2 atom\(s\) have been pending > 24h/);
    assert.match(out, /1 escalate\(s\) with no IT reply for > 48h/);
  });
});

/**
 * Strip ANSI colour codes so assertions don't have to care about
 * chalk's wrapping bytes when running in a colour-capable terminal.
 */
function stripAnsi(s: string): string {
  return s.replace(/\[[0-9;]*m/g, "");
}
