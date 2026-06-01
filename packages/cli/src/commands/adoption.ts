import chalk from "chalk";
import { buildAuditReport } from "../gateway/audit";
import { loadTelemetry } from "../gateway/atom-telemetry";
import { loadAtoms } from "../gateway/knowledge";
import { readMarkers } from "../run-markers";
import { buildAdoptionReport, type AdoptionReport } from "../adoption";

function println(s = ""): void {
  // eslint-disable-next-line no-console
  console.log(s);
}

export function renderAdoptionText(r: AdoptionReport): string {
  const lines: string[] = [];
  lines.push(chalk.bold("\npmk adoption — is anyone using this?"));
  lines.push(chalk.dim(`  window: last ${r.windowDays} day(s); reuse is cumulative; time-to-first-PRD is one-time\n`));
  lines.push(`  time-to-first-PRD:        ${r.timeToFirstPrd.display}`);
  lines.push(`  answered questions:       ${r.answeredQuestions.total} (${r.answeredQuestions.perWeek.toFixed(1)}/week)`);
  lines.push(
    `  self-answer rate:         ${r.selfAnswerRate.display}` +
      `  ${chalk.dim(`(mra-ask ${r.selfAnswerRate.mraAsk.successes}/${r.selfAnswerRate.mraAsk.invocations})`)}`,
  );
  lines.push(
    `  escalation → saved atom:  ${r.escalationToSavedAtom.display}` +
      `  ${chalk.dim(`(${r.escalationToSavedAtom.savedAtom}/${r.escalationToSavedAtom.triggered})`)}`,
  );
  lines.push(
    `  atom reuse rate:          ${r.atomReuseRate.display}` +
      `  ${chalk.dim(`(${r.atomReuseRate.reused}/${r.atomReuseRate.approved} atoms, ${r.atomReuseRate.totalReuses} reuses)`)}`,
  );
  return lines.join("\n");
}

export function adoptionCommand(opts: { days?: string; json?: boolean }): void {
  const parsed = opts.days !== undefined ? Number.parseInt(opts.days, 10) : NaN;
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
  const nowMs = Date.now();
  const report = buildAdoptionReport(
    buildAuditReport({ days, nowMs }),
    loadTelemetry(),
    loadAtoms({ promote: false }),
    readMarkers(),
    nowMs,
    days,
  );
  if (opts.json) {
    println(JSON.stringify(report, null, 2));
    return;
  }
  println(renderAdoptionText(report));
}
