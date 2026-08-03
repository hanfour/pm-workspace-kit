import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `appendJsonl` swallows filesystem failures on purpose — blocking the gateway
 * on a broken audit log would be worse than the missing line. The gap was that
 * the failure was then completely unobservable: no log, no counter, no doctor
 * check. For a daemon that publishes real GitHub approvals, the event log is
 * the only forensic record, so it could stop recording indefinitely with
 * nothing to notice.
 *
 * The trade-off is kept (still non-fatal); only the silence is removed.
 */
describe("audit write failure accounting", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-audit-fail-"));
  });
  afterEach(() => {
    fs.chmodSync(tmp, 0o700);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("counts a failed append instead of dropping it silently", async () => {
    const { appendJsonl, auditWriteFailures, resetAuditWriteFailures } =
      await import("../src/gateway/monthly-jsonl");
    resetAuditWriteFailures();
    assert.equal(auditWriteFailures().count, 0);

    // A file where the partition directory should be: mkdir/append both fail.
    const blocked = path.join(tmp, "blocked");
    fs.writeFileSync(blocked, "not a directory");

    appendJsonl(blocked, "events", { type: "review.approved" });

    const failures = auditWriteFailures();
    assert.equal(failures.count, 1, "the dropped line must be counted");
    assert.ok(failures.lastError, "the reason must be retained for the operator");
    assert.ok(failures.lastAt, "the time of the most recent drop must be retained");
  });

  it("stays non-fatal — the caller never sees the failure", async () => {
    const { appendJsonl } = await import("../src/gateway/monthly-jsonl");
    const blocked = path.join(tmp, "blocked2");
    fs.writeFileSync(blocked, "not a directory");
    assert.doesNotThrow(() => appendJsonl(blocked, "events", { a: 1 }));
  });

  it("does not count a successful append", async () => {
    const { appendJsonl, auditWriteFailures, resetAuditWriteFailures } =
      await import("../src/gateway/monthly-jsonl");
    resetAuditWriteFailures();
    appendJsonl(tmp, "events", { type: "turn.processed" });
    assert.equal(auditWriteFailures().count, 0);
  });
});

describe("audit-log doctor check", () => {
  it("passes when nothing has been dropped", async () => {
    const { auditLogCheck } = await import(
      "../src/gateway/doctor-checks/audit-log"
    );
    const { resetAuditWriteFailures } = await import(
      "../src/gateway/monthly-jsonl"
    );
    resetAuditWriteFailures();
    const res = await auditLogCheck({} as never);
    assert.equal(res.severity, "pass");
  });

  it("fails loudly once audit lines have been dropped", async () => {
    const { auditLogCheck } = await import(
      "../src/gateway/doctor-checks/audit-log"
    );
    const { appendJsonl, resetAuditWriteFailures } = await import(
      "../src/gateway/monthly-jsonl"
    );
    resetAuditWriteFailures();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-audit-doc-"));
    const blocked = path.join(tmp, "blocked");
    fs.writeFileSync(blocked, "not a directory");
    appendJsonl(blocked, "events", { a: 1 });

    const res = await auditLogCheck({} as never);
    assert.equal(res.severity, "fail");
    assert.match(res.message, /1/, "the count belongs in the message");
    assert.ok(res.hint, "an operator needs a next step");

    fs.rmSync(tmp, { recursive: true, force: true });
    resetAuditWriteFailures();
  });
});
