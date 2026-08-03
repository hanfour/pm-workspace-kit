import type { DoctorCheckResult, DoctorContext } from "../doctor";
import { auditWriteFailures } from "../monthly-jsonl";

/**
 * Surfaces audit lines this gateway process failed to persist.
 *
 * `appendJsonl` swallows filesystem failures by design — blocking the daemon
 * on a broken audit log would be worse than the missing line — so nothing else
 * ever reports them. That matters because the event log is the only forensic
 * record of privileged actions (`review.approved` among them): it can stop
 * recording while approvals keep succeeding.
 *
 * Counts are per PROCESS and reset on restart, so a zero here means "nothing
 * dropped since this gateway started", not "nothing ever dropped".
 */
export async function auditLogCheck(
  _ctx: DoctorContext,
): Promise<DoctorCheckResult> {
  const { count, lastError, lastAt } = auditWriteFailures();
  if (count === 0) {
    return {
      name: "audit-log",
      severity: "pass",
      message: "no audit lines dropped since this gateway started",
    };
  }
  return {
    name: "audit-log",
    severity: "fail",
    message:
      `${count} audit line(s) could not be written since this gateway started` +
      (lastAt ? ` (most recent ${lastAt})` : "") +
      (lastError ? `: ${lastError}` : ""),
    hint: "check free space and permissions on ~/.pmk; the event log is the only record of approvals and issue creation",
  };
}
