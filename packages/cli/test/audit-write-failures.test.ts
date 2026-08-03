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

  // An in-memory counter is invisible to the only thing that reads it. The
  // gateway accumulates failures in the long-lived `pmk gateway start`
  // process, while `pmk gateway doctor` runs in a FRESH CLI process and
  // `/pmk admin doctor` does not run DEFAULT_CHECKS at all — so a
  // process-local count can never reach an operator. It has to survive the
  // process boundary.
  describe("crossing the process boundary", () => {
    it("persists the count beside the partition it failed to write", async () => {
      const { appendJsonl, readPersistedAuditWriteFailures, resetAuditWriteFailures } =
        await import("../src/gateway/monthly-jsonl");
      resetAuditWriteFailures();
      // Directory is writable; the PARTITION FILE is not — the realistic
      // failure (wrong ownership on one file), and the one worth catching.
      const partitionDir = path.join(tmp, "gw");
      fs.mkdirSync(partitionDir);
      const { monthlyPath } = await import("../src/gateway/monthly-jsonl");
      const partition = monthlyPath(partitionDir, "events");
      fs.writeFileSync(partition, "");
      fs.chmodSync(partition, 0o400);

      appendJsonl(partitionDir, "events", { type: "review.approved" });

      // A different process would see this, having never held the counter.
      const persisted = readPersistedAuditWriteFailures(partitionDir);
      assert.equal(persisted.count, 1, "the drop must outlive the process");
      assert.ok(persisted.lastError);
      fs.chmodSync(partition, 0o600);
    });

    it("accumulates across restarts rather than resetting", async () => {
      const { appendJsonl, readPersistedAuditWriteFailures, resetAuditWriteFailures } =
        await import("../src/gateway/monthly-jsonl");
      const partitionDir = path.join(tmp, "gw2");
      fs.mkdirSync(partitionDir);
      const { monthlyPath } = await import("../src/gateway/monthly-jsonl");
      const partition = monthlyPath(partitionDir, "events");
      fs.writeFileSync(partition, "");
      fs.chmodSync(partition, 0o400);

      resetAuditWriteFailures(); // "first process"
      appendJsonl(partitionDir, "events", { a: 1 });
      resetAuditWriteFailures(); // "restart" — in-memory state is gone
      appendJsonl(partitionDir, "events", { a: 2 });

      assert.equal(
        readPersistedAuditWriteFailures(partitionDir).count,
        2,
        "a restart must not zero the record",
      );
      fs.chmodSync(partition, 0o600);
    });

    it("reports zero when nothing was ever dropped", async () => {
      const { readPersistedAuditWriteFailures } = await import(
        "../src/gateway/monthly-jsonl"
      );
      assert.equal(readPersistedAuditWriteFailures(tmp).count, 0);
    });
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

  // The check must read what the DAEMON persisted, not this process's memory —
  // doctor always runs somewhere else.
  it("reports drops recorded by another process", async () => {
    const ORIG = process.env.HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pmk-audit-doc-"));
    process.env.HOME = home;
    try {
      const { resetAuditWriteFailures } = await import(
        "../src/gateway/monthly-jsonl"
      );
      const { gatewayDir } = await import("../src/gateway/config");
      // Stand in for the daemon: a record on disk, with this process's
      // in-memory counter deliberately empty.
      resetAuditWriteFailures();
      const dir = gatewayDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "audit-write-failures.json"),
        JSON.stringify({ count: 3, lastError: "EACCES", lastAt: "2026-08-03T00:00:00.000Z" }),
      );

      const { auditLogCheck } = await import(
        "../src/gateway/doctor-checks/audit-log"
      );
      const res = await auditLogCheck({} as never);
      assert.equal(res.severity, "fail");
      assert.match(res.message, /3/, "the count belongs in the message");
      assert.ok(res.hint, "an operator needs a next step");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      if (ORIG !== undefined) process.env.HOME = ORIG;
    }
  });
});
