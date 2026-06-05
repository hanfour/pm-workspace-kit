import * as readline from "node:readline/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { println } from "../../io";
import {
  gatewayConfigPath,
  hasValidSlackTokens,
  loadGatewayConfig,
  saveGatewayConfig,
} from "../../gateway/config";
import { gatewayRunningPid, runGateway } from "../../gateway";
import { userStats } from "../../gateway/session-store";
import { findMraWorkspace } from "../../adapters/mra";
import { buildAuditReport } from "../../gateway/audit";
import { formatAuditReport } from "../../gateway/audit-format";
import {
  buildDoctorContext,
  formatDoctorReport,
  runDoctor,
} from "../../gateway/doctor";
import { DEFAULT_CHECKS } from "../../gateway/doctor-checks";
import {
  seedDemoAtom,
  unseedDemoAtoms,
} from "../../gateway/demo-seed";

/**
 * `pmk gateway demo <seed|unseed>` — smoke-test data for onboarding.
 *
 * `seed`   writes one KnowledgeAtom tagged `demo-seed` so a new host
 *          can verify the retrieval path immediately after install.
 *          Idempotent: re-running doesn't duplicate.
 * `unseed` removes every atom tagged `demo-seed`. Never touches real
 *          atoms; safe to run as the last step of an onboarding
 *          rehearsal.
 *
 * Polished AcmeAds demo bundle (multi-PRD, walkthrough script,
 * recorded run) is priorities-plan P5, NOT this command.
 */
export function demoCmd(rest: string[]): void {
  const action = rest[0];
  switch (action) {
    case "seed": {
      const r = seedDemoAtom();
      if (r.written) {
        println(chalk.green(`✓ wrote demo atom: ${r.atomId}`));
        println(chalk.dim(`  file: ${r.filePath}`));
      } else {
        println(
          chalk.yellow(
            `demo atom already present (id=${r.atomId}); no changes written.`,
          ),
        );
        println(chalk.dim(`  file: ${r.filePath}`));
      }
      println("");
      println(chalk.bold("next step (smoke test):"));
      println(`  1. start the gateway:  pmk gateway start`);
      println(`  2. in Slack, DM the bot or @-mention it with:`);
      println(chalk.cyan(`       ${r.question}`));
      println("  3. you should see the bot quote the demo answer.");
      println("");
      println(chalk.dim("clean up later with: pmk gateway demo unseed"));
      return;
    }
    case "unseed": {
      const r = unseedDemoAtoms();
      if (r.removed.length === 0) {
        println(chalk.yellow("no demo atoms found; nothing to remove."));
      } else {
        println(chalk.green(`✓ removed ${r.removed.length} demo atom(s):`));
        for (const id of r.removed) println(chalk.dim(`    - ${id}`));
      }
      return;
    }
    default:
      println(chalk.yellow("usage: pmk gateway demo <seed|unseed>"));
      process.exit(1);
  }
}

/**
 * `pmk gateway doctor [--json]` — pre-flight check before runtime.
 * Read-only: never writes config, never posts to Slack. Exit code 1
 * if any check FAILs, 0 otherwise (WARNs are non-fatal).
 *
 * --json emits the structured report for CI / hooks.
 */
export async function doctorCmd(rest: string[]): Promise<void> {
  const json = rest.includes("--json");
  const ctx = buildDoctorContext();
  const report = await runDoctor(ctx, DEFAULT_CHECKS);
  println(formatDoctorReport(report, { json }));
  if (report.failed > 0) {
    process.exit(1);
  }
}

/**
 * `pmk gateway audit [--days N]` — operator-facing rollup of the
 * knowledge loop's recent activity. Default window is 7 days.
 *
 * The number `--days` cap exists so an operator who types `--days 999`
 * doesn't accidentally scan years of events for a hosted gateway. 365
 * is generous; bump if real workloads need it.
 */
export function auditCmd(rest: string[]): void {
  const daysIdx = rest.indexOf("--days");
  let days = 7;
  if (daysIdx >= 0) {
    const raw = rest[daysIdx + 1];
    const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      println(
        chalk.red(
          `invalid --days '${raw ?? ""}'. Expected a positive integer (e.g. --days 14).`,
        ),
      );
      process.exit(1);
    }
    if (parsed > 365) {
      println(
        chalk.yellow(
          `  warning: --days ${parsed} clamped to 365. Open an issue if you need a longer audit window.`,
        ),
      );
      days = 365;
    } else {
      days = parsed;
    }
  }
  const report = buildAuditReport({ days });
  println("");
  println(formatAuditReport(report));
}

export async function initCmd(): Promise<void> {
  const existing = loadGatewayConfig();
  println(chalk.bold("\npmk gateway — initial setup"));
  println(
    chalk.dim(
      "  This writes ~/.pmk/gateway.json with your Slack app credentials.",
    ),
  );
  println(
    chalk.dim(
      "  Both tokens are written with mode 0600. To rotate later, run init again or edit the file.",
    ),
  );
  println("");
  println(chalk.dim("  Slack app setup (one-time, ~5 min):"));
  println(
    chalk.dim(
      "    1. Open https://api.slack.com/apps?new_app=1 → 'From a manifest'",
    ),
  );
  println(chalk.dim("    2. Paste the contents of:"));
  println(
    chalk.dim(
      "         packages/cli/src/gateway/slack/manifest.template.json",
    ),
  );
  println(chalk.dim("       (or use the raw URL:"));
  println(
    chalk.dim(
      "         https://raw.githubusercontent.com/hanfour/pm-workspace-kit/main/packages/cli/src/gateway/slack/manifest.template.json )",
    ),
  );
  println(chalk.dim("    3. Install to Workspace, then copy:"));
  println(
    chalk.dim(
      "         - App-Level Token (xapp-...)  — auto-generated for Socket Mode",
    ),
  );
  println(chalk.dim("         - Bot User OAuth Token (xoxb-...)"));
  println("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const appToken =
      (
        await rl.question(
          chalk.cyan(
            `App-Level Token (xapp-...) ${existing.slack.appToken ? "[unchanged on enter]" : ""}: `,
          ),
        )
      ).trim() || existing.slack.appToken;
    const botToken =
      (
        await rl.question(
          chalk.cyan(
            `Bot Token (xoxb-...) ${existing.slack.botToken ? "[unchanged on enter]" : ""}: `,
          ),
        )
      ).trim() || existing.slack.botToken;
    const defaultIngest =
      (
        await rl.question(
          chalk.cyan(
            `Default ingest spec (e.g. mra:--all, blank for none) ${existing.defaultIngest ?? ""}: `,
          ),
        )
      ).trim() || existing.defaultIngest;

    // mra workspace path. Auto-detect from cwd if the user is sitting
    // inside one; otherwise leave blank so the gateway uses the launch
    // cwd at runtime (v0.7.0 behaviour). Stored as absolute path.
    const detected = findMraWorkspace(process.cwd());
    const suggestion = existing.mraWorkspace ?? detected ?? "";
    const mraWorkspaceRaw = (
      await rl.question(
        chalk.cyan(
          `mra workspace path (where .collab/repos.json lives) ${
            suggestion ? `[${suggestion}]` : "[blank to skip]"
          }: `,
        ),
      )
    ).trim();
    const mraWorkspace = mraWorkspaceRaw
      ? path.resolve(
          mraWorkspaceRaw.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"),
        )
      : suggestion || undefined;
    if (
      mraWorkspace &&
      !fs.existsSync(path.join(mraWorkspace, ".collab", "repos.json"))
    ) {
      println(
        chalk.yellow(
          `  warning: '${mraWorkspace}' has no .collab/repos.json. mra-ask will fail until you run \`mra init\` there.`,
        ),
      );
    }

    println("");
    println(
      chalk.dim(
        "  v0.12+: pmk gateway prefers the Anthropic API directly (no SDK overhead).",
      ),
    );
    println(
      chalk.dim(
        "    If you skip this prompt, set ANTHROPIC_API_KEY in your environment, or",
      ),
    );
    println(
      chalk.dim(
        "    keep the legacy claude-agent path with PMK_PROVIDER=claude-agent.",
      ),
    );
    const apiKeyInput = (
      await rl.question(
        chalk.cyan(
          `Anthropic API key (sk-ant-...) ${existing.apiKey ? "[unchanged on enter]" : "[blank to use env var]"}: `,
        ),
      )
    ).trim();
    const apiKey = apiKeyInput || existing.apiKey;

    const cfg = {
      version: 1 as const,
      blocklist: existing.blocklist,
      admins: existing.admins,
      defaultIngest: defaultIngest || undefined,
      mraWorkspace,
      audience: existing.audience,
      escalation: existing.escalation,
      ...(apiKey ? { apiKey } : {}),
      slack: { appToken, botToken },
    };
    if (!hasValidSlackTokens(cfg)) {
      println(
        chalk.red(
          "tokens missing or wrong format (must start with xapp-/xoxb-). Aborting.",
        ),
      );
      process.exit(1);
    }
    const file = saveGatewayConfig(cfg);
    println(chalk.green(`\nsaved → ${file}`));
    println(chalk.dim("Next: `pmk gateway start`"));
  } finally {
    rl.close();
  }
}

export async function startCmd(rest: string[] = []): Promise<void> {
  const dryRun = rest.includes("--dry-run");
  const existing = gatewayRunningPid();
  if (existing) {
    println(
      chalk.yellow(
        `gateway already running (pid ${existing}). Stop it first or run \`pmk gateway status\`.`,
      ),
    );
    process.exit(1);
  }
  try {
    await runGateway({ dryRun });
  } catch (err) {
    println(chalk.red(`[pmk] ${(err as Error).message}`));
    process.exit(1);
  }
}

export function statusCmd(): void {
  const pid = gatewayRunningPid();
  const cfg = loadGatewayConfig();
  println(chalk.bold("\npmk gateway status"));
  println(`  config:    ${gatewayConfigPath()}`);
  println(
    `  configured: ${hasValidSlackTokens(cfg) ? chalk.green("yes") : chalk.red("no — run `pmk gateway init`")}`,
  );
  println(
    `  running:   ${pid ? chalk.green(`yes (pid ${pid})`) : chalk.gray("no")}`,
  );
  if (cfg.mraWorkspace) {
    const valid = fs.existsSync(
      path.join(cfg.mraWorkspace, ".collab", "repos.json"),
    );
    println(
      `  mra ws:    ${cfg.mraWorkspace} ${valid ? chalk.green("(ok)") : chalk.red("(no .collab/repos.json)")}`,
    );
  } else {
    println(
      `  mra ws:    ${chalk.gray("not set — falls back to launch cwd walk")}`,
    );
  }
  if (cfg.blocklist.length) {
    println(`  blocklist: ${cfg.blocklist.join(", ")}`);
  }
}

export function statsCmd(rest: string[]): void {
  const hours = rest[0] ? parseInt(rest[0], 10) : 168; // default 7 days
  const stats = userStats(Number.isFinite(hours) ? hours : 168);
  if (stats.length === 0) {
    println(chalk.yellow(`no activity in last ${hours}h.`));
    return;
  }
  println(chalk.bold(`\nUsage in last ${hours}h (Slack DM only):`));
  println(chalk.dim("  user                  turns   ~tokens   last seen"));
  for (const s of stats) {
    const last = new Date(s.lastActiveAt).toISOString().slice(0, 19);
    const id = (s.displayName ?? s.userId).padEnd(20).slice(0, 20);
    const turns = String(s.turns).padStart(5);
    const tokens = s.approxTokens.toLocaleString().padStart(8);
    println(`  ${id}  ${turns}   ${tokens}   ${last}`);
  }
}
