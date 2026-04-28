import * as readline from "node:readline/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { AUDIENCE_KEYS, type AudienceKey } from "@pmk/shared";
import { println } from "../io";
import {
  gatewayConfigPath,
  hasValidSlackTokens,
  loadGatewayConfig,
  saveGatewayConfig,
} from "../gateway/config";
import { gatewayRunningPid, runGateway } from "../gateway";
import { userStats } from "../gateway/session-store";
import { findMraWorkspace } from "../adapters/mra";

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
    case "audience":
      return audienceCmd(rest);
    case "escalation":
      return escalationCmd(rest);
    default:
      println(
        chalk.yellow(
          "usage: pmk gateway <init|start|status|stats|audience|escalation>",
        ),
      );
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

    const cfg = {
      version: 1 as const,
      blocklist: existing.blocklist,
      defaultIngest: defaultIngest || undefined,
      mraWorkspace,
      audience: existing.audience,
      escalation: existing.escalation,
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

function isAudienceKey(s: string): s is AudienceKey {
  return (AUDIENCE_KEYS as readonly string[]).includes(s);
}

/**
 * Slack workspace user IDs are `U` (regular) or `W` (enterprise grid)
 * followed by uppercase alphanum. We reject anything else with a hint
 * so hosts catch typos like `@hanfour` early.
 */
const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{2,}$/;

function ensureValidSlackUserId(userId: string): boolean {
  if (SLACK_USER_ID_RE.test(userId)) return true;
  println(
    chalk.red(
      `invalid Slack user ID '${userId}'. Expected format e.g. U0B05XYZ — open Slack profile → 'Copy member ID'.`,
    ),
  );
  return false;
}

function audienceUsage(): void {
  println(
    chalk.yellow(
      "usage:\n" +
        "  pmk gateway audience list\n" +
        "  pmk gateway audience set <userId> <tech|biz|exec>\n" +
        "  pmk gateway audience unset <userId>\n" +
        "  pmk gateway audience default <tech|biz|exec>",
    ),
  );
}

function audienceCmd(rest: string[]): void {
  const [action, ...args] = rest;
  const cfg = loadGatewayConfig();
  switch (action) {
    case undefined:
    case "list": {
      println(chalk.bold("\npmk gateway audience"));
      println(`  default: ${chalk.cyan(cfg.audience.default)}`);
      const entries = Object.entries(cfg.audience.users);
      if (entries.length === 0) {
        println(chalk.dim("  (no per-user overrides)"));
      } else {
        println(chalk.dim("  per-user overrides:"));
        for (const [uid, aud] of entries) {
          println(`    ${uid.padEnd(14)} → ${aud}`);
        }
      }
      return;
    }
    case "set": {
      const [userId, audience] = args;
      if (!userId || !audience) {
        audienceUsage();
        process.exit(1);
      }
      if (!ensureValidSlackUserId(userId)) process.exit(1);
      if (!isAudienceKey(audience)) {
        println(
          chalk.red(
            `invalid audience '${audience}'. Allowed: tech / biz / exec.`,
          ),
        );
        process.exit(1);
      }
      cfg.audience.users[userId] = audience;
      saveGatewayConfig(cfg);
      println(chalk.green(`set ${userId} → ${audience}`));
      return;
    }
    case "unset": {
      const [userId] = args;
      if (!userId) {
        audienceUsage();
        process.exit(1);
      }
      if (!ensureValidSlackUserId(userId)) process.exit(1);
      if (!(userId in cfg.audience.users)) {
        println(chalk.dim(`(${userId} had no override; nothing to do)`));
        return;
      }
      delete cfg.audience.users[userId];
      saveGatewayConfig(cfg);
      println(chalk.green(`removed override for ${userId}`));
      return;
    }
    case "default": {
      const [audience] = args;
      if (!audience || !isAudienceKey(audience)) {
        audienceUsage();
        process.exit(1);
      }
      cfg.audience.default = audience;
      saveGatewayConfig(cfg);
      println(chalk.green(`default audience set to ${audience}`));
      return;
    }
    default:
      audienceUsage();
      process.exit(1);
  }
}

function escalationUsage(): void {
  println(
    chalk.yellow(
      "usage:\n" +
        "  pmk gateway escalation list\n" +
        "  pmk gateway escalation add <repo|--default> <userId>\n" +
        "  pmk gateway escalation remove <repo|--default> <userId>",
    ),
  );
}

function escalationCmd(rest: string[]): void {
  const [action, scope, userId] = rest;
  const cfg = loadGatewayConfig();
  switch (action) {
    case undefined:
    case "list": {
      println(chalk.bold("\npmk gateway escalation"));
      println(
        `  default pool: ${
          cfg.escalation.default.length
            ? cfg.escalation.default.join(", ")
            : chalk.dim("(empty)")
        }`,
      );
      const repoEntries = Object.entries(cfg.escalation.repos);
      if (repoEntries.length === 0) {
        println(chalk.dim("  no repo-specific pools"));
      } else {
        for (const [repo, ids] of repoEntries) {
          println(
            `  ${repo.padEnd(14)} → ${ids.join(", ") || chalk.dim("(empty)")}`,
          );
        }
      }
      return;
    }
    case "add": {
      if (!scope || !userId) {
        escalationUsage();
        process.exit(1);
      }
      if (!ensureValidSlackUserId(userId)) process.exit(1);
      const pool =
        scope === "--default"
          ? cfg.escalation.default
          : (cfg.escalation.repos[scope] ??= []);
      if (!pool.includes(userId)) pool.push(userId);
      saveGatewayConfig(cfg);
      println(
        chalk.green(
          `added ${userId} to ${scope === "--default" ? "default pool" : `${scope} pool`}`,
        ),
      );
      return;
    }
    case "remove": {
      if (!scope || !userId) {
        escalationUsage();
        process.exit(1);
      }
      if (!ensureValidSlackUserId(userId)) process.exit(1);
      const pool =
        scope === "--default"
          ? cfg.escalation.default
          : cfg.escalation.repos[scope];
      if (!pool) {
        println(chalk.dim(`(${scope} pool empty; nothing to do)`));
        return;
      }
      const idx = pool.indexOf(userId);
      if (idx >= 0) pool.splice(idx, 1);
      saveGatewayConfig(cfg);
      println(
        chalk.green(
          `removed ${userId} from ${scope === "--default" ? "default pool" : `${scope} pool`}`,
        ),
      );
      return;
    }
    default:
      escalationUsage();
      process.exit(1);
  }
}
