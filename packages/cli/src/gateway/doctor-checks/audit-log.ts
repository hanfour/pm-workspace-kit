import type { DoctorCheckResult, DoctorContext } from "../doctor";
import { gatewayDir } from "../config";
import { readPersistedAuditWriteFailures } from "../monthly-jsonl";

/**
 * Surfaces audit lines this gateway process failed to persist.
 *
 * `appendJsonl` swallows filesystem failures by design — blocking the daemon
 * on a broken audit log would be worse than the missing line — so nothing else
 * ever reports them. That matters because the event log is the only forensic
 * record of privileged actions (`review.approved` among them): it can stop
 * recording while approvals keep succeeding.
 *
 * Reads the DURABLE record, not this process's counter: doctor always runs in
 * a fresh CLI process, so a process-local count would be structurally stuck at
 * zero and the check would never fire.
 *
 * The record accumulates across restarts and is cleared only by deleting it.
 * A zero is therefore "nothing has been dropped", with one honest limit: a
 * failure severe enough to make ~/.pmk itself unwritable also prevents the
 * record from being written.
 */
export async function auditLogCheck(
  _ctx: DoctorContext,
): Promise<DoctorCheckResult> {
  const dir = gatewayDir();
  const { count, lastError, lastAt } = readPersistedAuditWriteFailures(dir);
  if (count === 0) {
    return {
      name: "audit-log",
      severity: "pass",
      message: "no audit lines recorded as dropped",
    };
  }
  return {
    name: "audit-log",
    severity: "fail",
    message:
      `${count} audit line(s) could not be written` +
      (lastAt ? ` (most recent ${lastAt})` : "") +
      (lastError ? `: ${lastError}` : ""),
    hint:
      "check free space and permissions on ~/.pmk; the event log is the only record of approvals and issue creation. " +
      `Clear the record with: rm ${dir}/audit-write-failures.json`,
  };
}
