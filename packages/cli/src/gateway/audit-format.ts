/**
 * Terminal formatter for {@link AuditReport} (v0.10 / #24).
 *
 * Pure: takes a report, returns a string. No I/O. The CLI command
 * does the println. Kept separate from the aggregator so the report
 * can be rendered as JSON / piped elsewhere later without untangling.
 */
import chalk from "chalk";
import type { AuditReport } from "./audit";

const LABEL_PAD = 30;
/** How many top entries to show before collapsing the rest into "OTHER". */
const TOP_N = 3;

export function formatAuditReport(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(chalk.bold(`pmk gateway audit (last ${report.windowDays} days)`));
  lines.push("");

  // Conversations
  lines.push(chalk.bold("Conversations"));
  lines.push(label("total turns:") + report.conversations.totalTurns);
  lines.push(
    label("per-user breakdown:") +
      formatTopWithOther(report.conversations.perUser),
  );
  lines.push(
    label("per-audience breakdown:") +
      formatList(
        report.conversations.perAudience,
        (e) => `${e.audience} ${e.turns}`,
      ),
  );
  lines.push("");

  // mra-ask
  lines.push(chalk.bold("mra-ask"));
  lines.push(
    label("invocations:") +
      `${report.mraAsk.invocations}${pctOfTurns(
        report.mraAsk.invocations,
        report.conversations.totalTurns,
      )}`,
  );
  lines.push(
    label("successes / retries / fails:") +
      `${report.mraAsk.successes} / ${report.mraAsk.retries} / ${report.mraAsk.failures}`,
  );
  lines.push(
    label("median duration:") +
      formatDurationMs(report.mraAsk.medianDurationMs),
  );
  lines.push(
    label("top repos asked:") +
      formatList(report.mraAsk.topRepos, (e) => `${e.repo} ×${e.count}`),
  );
  lines.push("");

  // escalate
  lines.push(chalk.bold("escalate"));
  lines.push(label("triggered:") + report.escalate.triggered);
  lines.push(label("absorbed (atom landed):") + report.escalate.absorbed);
  lines.push(label("pending (no reply yet):") + report.escalate.pending);
  lines.push(
    label("median time-to-IT-reply:") +
      formatDurationMs(report.escalate.medianTimeToReplyMs),
  );
  lines.push("");

  // atoms
  lines.push(chalk.bold("knowledge atoms"));
  lines.push(
    label("total:") +
      `${report.atoms.total} (${report.atoms.approved} approved, ${report.atoms.pending} pending)`,
  );
  lines.push(
    label("retrieval injections:") +
      `${report.atoms.retrievalInjections}${ratePerTurn(
        report.atoms.retrievalInjections,
        report.conversations.totalTurns,
      )}`,
  );
  lines.push(
    label("median atoms-injected/turn:") +
      (report.atoms.medianAtomsInjectedPerTurn === undefined
        ? "—"
        : formatDecimal(report.atoms.medianAtomsInjectedPerTurn)),
  );
  lines.push(
    label("top contributors:") +
      formatList(
        report.atoms.topContributors,
        (e) => `${e.userId} ×${e.count}`,
      ),
  );

  // flags
  if (report.flags.length > 0) {
    lines.push("");
    lines.push(chalk.bold(chalk.yellow("flags")));
    for (const f of report.flags) {
      lines.push("  " + chalk.bold(chalk.yellow("WARN")) + " " + f);
    }
  }

  return lines.join("\n");
}

/**
 * Render a duration in human-readable form. Tiers chosen to match
 * what an operator scans for: seconds for snappy ops, minutes when
 * latency starts to bite, hours/days for backlog problems.
 *
 * Returns "—" for undefined so empty reports don't render "NaNs" or
 * "0s" (which would falsely imply a measurement happened).
 */
export function formatDurationMs(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.round(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours === 0 ? `${days}d` : `${days}d ${remHours}h`;
}

function label(text: string): string {
  return "  " + chalk.dim(text.padEnd(LABEL_PAD));
}

function pctOfTurns(numerator: number, totalTurns: number): string {
  if (totalTurns === 0) return "";
  const pct = (numerator / totalTurns) * 100;
  return ` (${formatDecimal(pct)}% of turns)`;
}

/**
 * Render a per-turn ratio. Used for atomsInjected which can exceed
 * 1.0 (multiple atoms per turn average), where "% of turns" reads
 * misleadingly above 100%. "0.25 atoms/turn" / "1.5 atoms/turn"
 * scale cleanly at any density.
 */
function ratePerTurn(numerator: number, totalTurns: number): string {
  if (totalTurns === 0) return "";
  const rate = numerator / totalTurns;
  return ` (${formatRate(rate)} atoms/turn)`;
}

function formatDecimal(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : n.toFixed(1);
}

/**
 * 2 decimals for sub-1 rates so 0.05 / 0.25 don't both collapse to
 * "0.1"; 1 decimal once the rate is large enough that the second
 * digit is noise.
 */
function formatRate(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n < 1 ? n.toFixed(2) : n.toFixed(1);
}

function formatList<T>(items: T[], render: (item: T) => string): string {
  if (items.length === 0) return chalk.dim("(none)");
  return items.map(render).join(", ");
}

/**
 * Show the top N entries verbatim, then collapse the rest into a
 * single "U_OTHER ×<count> = <sumOfTurns>" tail. Mirrors the issue
 * sketch — the operator wants to see the heavy hitters without losing
 * the long-tail volume.
 */
function formatTopWithOther(
  items: Array<{ userId: string; turns: number }>,
): string {
  if (items.length === 0) return chalk.dim("(none)");
  const head = items.slice(0, TOP_N);
  const tail = items.slice(TOP_N);
  const headPart = head.map((e) => `${e.userId} ${e.turns}`).join(", ");
  if (tail.length === 0) return headPart;
  const tailSum = tail.reduce((acc, e) => acc + e.turns, 0);
  return `${headPart}, U_OTHER ×${tail.length} = ${tailSum}`;
}
