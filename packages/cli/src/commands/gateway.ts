import * as readline from "node:readline/promises";
import chalk from "chalk";
import { println } from "../io";
import {
  gatewayConfigPath,
  hasValidSlackTokens,
  loadGatewayConfig,
  saveGatewayConfig,
} from "../gateway/config";
import { gatewayRunningPid, runGateway } from "../gateway";
import { userStats } from "../gateway/session-store";

export async function gatewayCommand(
  action: string,
  rest: string[],
): Promise<void> {
  switch (action) {
    case "init":
      return await initCmd();
    case "start":
      return await startCmd();
    case "status":
      return statusCmd();
    case "stats":
      return statsCmd(rest);
    default:
      println(chalk.yellow("usage: pmk gateway <init|start|status|stats>"));
      process.exit(1);
  }
}

async function initCmd(): Promise<void> {
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
  println(chalk.dim("  Steps to get the tokens (one-time, ~5 min):"));
  println(
    chalk.dim(
      "    1. https://api.slack.com/apps → Create New App → From scratch",
    ),
  );
  println(chalk.dim("    2. Socket Mode → Enable → generate App-Level Token"));
  println(
    chalk.dim(
      "       Scopes: connections:write — copy the `xapp-...` value when prompted.",
    ),
  );
  println(
    chalk.dim(
      "    3. Event Subscriptions → Enable; subscribe to:  message.im, app_mention",
    ),
  );
  println(chalk.dim("    4. OAuth & Permissions → Scopes (Bot Token):"));
  println(
    chalk.dim(
      "         app_mentions:read, chat:write, im:history, im:read, im:write, users:read",
    ),
  );
  println(
    chalk.dim(
      "    5. Install to Workspace → copy `xoxb-...` Bot User OAuth Token.",
    ),
  );
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

    const cfg = {
      version: 1 as const,
      blocklist: existing.blocklist,
      defaultIngest: defaultIngest || undefined,
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

async function startCmd(): Promise<void> {
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
    await runGateway();
  } catch (err) {
    println(chalk.red(`[pmk] ${(err as Error).message}`));
    process.exit(1);
  }
}

function statusCmd(): void {
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
  if (cfg.blocklist.length) {
    println(`  blocklist: ${cfg.blocklist.join(", ")}`);
  }
}

function statsCmd(rest: string[]): void {
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
