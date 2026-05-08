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
import {
  approveAtom,
  findAtomByPrefix,
  loadAtoms,
  rejectAtom,
  searchAtoms,
} from "../gateway/knowledge";
import {
  approvedAtomCount,
  ATOM_RANKED_THRESHOLD,
  buildAtomsIndex,
} from "../gateway/atom-index";
import { appendAdminLog, cliActor } from "../gateway/admin-log";
import { buildAuditReport } from "../gateway/audit";
import { formatAuditReport } from "../gateway/audit-format";
import { spawnSync } from "node:child_process";

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
    case "atoms":
      return atomsCmd(rest);
    case "admin":
      return adminBootstrapCmd(rest);
    case "audit":
      return auditCmd(rest);
    default:
      println(
        chalk.yellow(
          "usage: pmk gateway <init|start|status|stats|audience|escalation|atoms|admin|audit>",
        ),
      );
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
function auditCmd(rest: string[]): void {
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
      "    3. Event Subscriptions → Enable; subscribe to:  message.im, app_mention, reaction_added (v0.8.5+)",
    ),
  );
  println(chalk.dim("    4. OAuth & Permissions → Scopes (Bot Token):"));
  println(
    chalk.dim(
      "         app_mentions:read, chat:write, im:history, im:read, im:write, users:read,\n" +
        "         reactions:read (v0.8.5+; enables ✅/❌ atom approval on the bot's pending notice)",
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

/**
 * Slack channel IDs (#23): `C` (public), `G` (private), or `D` (DM)
 * followed by uppercase alphanum. DM IDs are accepted because the
 * channel-default mechanism still works there even though
 * per-channel overrides for DMs are degenerate (per-user already
 * covers the same ground).
 */
const SLACK_CHANNEL_ID_RE = /^[CGD][A-Z0-9]{2,}$/;

function ensureValidSlackChannelId(channelId: string): boolean {
  if (SLACK_CHANNEL_ID_RE.test(channelId)) return true;
  println(
    chalk.red(
      `invalid Slack channel ID '${channelId}'. Expected format e.g. C0AVD1XD946 — channel name → 'View channel details' → 'Copy channel ID'.`,
    ),
  );
  return false;
}

function audienceUsage(): void {
  println(
    chalk.yellow(
      "usage:\n" +
        "  pmk gateway audience list\n" +
        "  pmk gateway audience set <userId> <tech|pm|biz|exec>\n" +
        "  pmk gateway audience unset <userId>\n" +
        "  pmk gateway audience set-channel <channelId> <tech|pm|biz|exec>\n" +
        "  pmk gateway audience unset-channel <channelId>\n" +
        "  pmk gateway audience default <tech|pm|biz|exec>",
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
      const userEntries = Object.entries(cfg.audience.users);
      if (userEntries.length === 0) {
        println(chalk.dim("  (no per-user overrides)"));
      } else {
        println(chalk.dim("  per-user overrides:"));
        for (const [uid, aud] of userEntries) {
          println(`    ${uid.padEnd(14)} → ${aud}`);
        }
      }
      const channelEntries = Object.entries(cfg.audience.channels);
      if (channelEntries.length === 0) {
        println(chalk.dim("  (no per-channel overrides)"));
      } else {
        println(chalk.dim("  per-channel overrides:"));
        for (const [cid, aud] of channelEntries) {
          println(`    ${cid.padEnd(14)} → ${aud}`);
        }
      }
      println(
        chalk.dim(
          "  resolution order at turn time: per-user → per-channel → default",
        ),
      );
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
            `invalid audience '${audience}'. Allowed: tech / pm / biz / exec.`,
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
    case "set-channel": {
      const [channelId, audience] = args;
      if (!channelId || !audience) {
        audienceUsage();
        process.exit(1);
      }
      if (!ensureValidSlackChannelId(channelId)) process.exit(1);
      if (!isAudienceKey(audience)) {
        println(
          chalk.red(
            `invalid audience '${audience}'. Allowed: tech / pm / biz / exec.`,
          ),
        );
        process.exit(1);
      }
      cfg.audience.channels[channelId] = audience;
      saveGatewayConfig(cfg);
      println(chalk.green(`set channel ${channelId} → ${audience}`));
      return;
    }
    case "unset-channel": {
      const [channelId] = args;
      if (!channelId) {
        audienceUsage();
        process.exit(1);
      }
      if (!ensureValidSlackChannelId(channelId)) process.exit(1);
      if (!(channelId in cfg.audience.channels)) {
        println(chalk.dim(`(${channelId} had no override; nothing to do)`));
        return;
      }
      delete cfg.audience.channels[channelId];
      saveGatewayConfig(cfg);
      println(chalk.green(`removed channel override for ${channelId}`));
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
        "  pmk gateway escalation add <repo|default> <userId>\n" +
        "  pmk gateway escalation remove <repo|default> <userId>",
    ),
  );
}

/**
 * Resolve a user-supplied scope token to the canonical form. The
 * canonical name for the default pool is `default` (positional, no
 * dashes), but we also tolerate the legacy `--default` form for
 * scripts that worked around the commander option-eating bug with
 * `pmk gateway escalation add -- --default <id>`. Returns `null` when
 * the token is the default sentinel; the actual repo string otherwise.
 *
 * Side effect: warns once when the deprecated form is used.
 */
function normaliseEscalationScope(scope: string): string | null {
  if (scope === "default") return null;
  if (scope === "--default") {
    println(
      chalk.yellow(
        "  warning: `--default` is deprecated; use the positional `default` (no dashes) instead.",
      ),
    );
    return null;
  }
  return scope;
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
      const repo = normaliseEscalationScope(scope);
      const pool =
        repo === null
          ? cfg.escalation.default
          : (cfg.escalation.repos[repo] ??= []);
      if (!pool.includes(userId)) pool.push(userId);
      saveGatewayConfig(cfg);
      println(
        chalk.green(
          `added ${userId} to ${repo === null ? "default pool" : `${repo} pool`}`,
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
      const repo = normaliseEscalationScope(scope);
      const pool =
        repo === null ? cfg.escalation.default : cfg.escalation.repos[repo];
      if (!pool) {
        println(chalk.dim(`(${repo} pool empty; nothing to do)`));
        return;
      }
      const idx = pool.indexOf(userId);
      if (idx >= 0) pool.splice(idx, 1);
      saveGatewayConfig(cfg);
      println(
        chalk.green(
          `removed ${userId} from ${repo === null ? "default pool" : `${repo} pool`}`,
        ),
      );
      return;
    }
    default:
      escalationUsage();
      process.exit(1);
  }
}

function atomsUsage(): void {
  println(
    chalk.yellow(
      "usage:\n" +
        "  pmk gateway atoms list [--all|--pending|--approved] [--scope <name>]\n" +
        "  pmk gateway atoms show <id-or-prefix>\n" +
        "  pmk gateway atoms search <query> [--scope <name>] [--limit N]\n" +
        "  pmk gateway atoms edit <id-or-prefix>\n" +
        "  pmk gateway atoms approve <id-or-prefix>\n" +
        "  pmk gateway atoms reject <id-or-prefix>\n" +
        "  pmk gateway atoms reindex [--scope <name>]",
    ),
  );
}

function formatAtomRow(atom: {
  id: string;
  scope: string;
  question: string;
  status?: string;
  expiresAt?: number;
}): string {
  const statusTag =
    atom.status === "pending"
      ? chalk.yellow("pending ")
      : chalk.green("approved");
  const idShort = atom.id
    .split("-")
    .slice(0, 2)
    .join("-")
    .padEnd(20)
    .slice(0, 20);
  const ttl = atom.expiresAt
    ? ` (TTL ${Math.max(0, Math.floor((atom.expiresAt - Date.now()) / 60_000))}m)`
    : "";
  const q = atom.question.slice(0, 70);
  return `  ${statusTag}  ${idShort}  ${atom.scope.padEnd(10).slice(0, 10)}  ${q}${ttl}`;
}

function atomsCmd(rest: string[]): void {
  const [action, ...args] = rest;
  switch (action) {
    case undefined:
    case "list": {
      const filter = args.includes("--pending")
        ? "pending"
        : args.includes("--approved")
          ? "approved"
          : "all";
      const scopeIdx = args.indexOf("--scope");
      const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : undefined;
      const atoms = loadAtoms({ scope }).filter((a) =>
        filter === "all" ? true : a.status === filter,
      );
      println(chalk.bold(`\npmk gateway atoms (${filter})`));
      if (atoms.length === 0) {
        println(chalk.dim("  (none)"));
        return;
      }
      println(
        chalk.dim("  status    id-prefix             scope       question"),
      );
      for (const a of atoms) println(formatAtomRow(a));
      return;
    }
    case "show": {
      const [idOrPrefix] = args;
      if (!idOrPrefix) {
        atomsUsage();
        process.exit(1);
      }
      const found = findAtomByPrefix(idOrPrefix);
      if (!found) {
        println(
          chalk.red(
            `no unique match for '${idOrPrefix}'. Try a longer prefix.`,
          ),
        );
        process.exit(1);
      }
      println(chalk.bold(`\n${found.atom.question}`));
      println(chalk.dim(`  id:       ${found.atom.id}`));
      println(chalk.dim(`  scope:    ${found.atom.scope}`));
      println(chalk.dim(`  status:   ${found.atom.status}`));
      if (found.atom.expiresAt) {
        const minsLeft = Math.max(
          0,
          Math.floor((found.atom.expiresAt - Date.now()) / 60_000),
        );
        println(chalk.dim(`  expires:  in ${minsLeft}m`));
      }
      println(
        chalk.dim(
          `  source:   ${found.atom.source.threadKey} via <@${found.atom.source.contributorUserId}>`,
        ),
      );
      println(chalk.dim(`  tags:     ${found.atom.tags.join(", ") || "—"}`));
      println(chalk.dim(`  file:     ${found.file}`));
      println("");
      if (found.atom.summary) {
        println(chalk.bold("Summary"));
        println(found.atom.summary);
        println("");
      }
      println(chalk.bold("Answer"));
      println(found.atom.answer);
      return;
    }
    case "search": {
      // pmk gateway atoms search <query> [--scope <name>] [--limit N]
      // Wraps searchAtoms() so the host can dry-run retrieval ranking
      // without sending a real Slack message — useful after adding a
      // new atom to verify "would this be retrieved when someone asks
      // X?" without DM-ing the bot.
      const scopeIdx = args.indexOf("--scope");
      const limitIdx = args.indexOf("--limit");
      const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : undefined;
      const limitArg =
        limitIdx >= 0 ? Number.parseInt(args[limitIdx + 1], 10) : NaN;
      const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : 5;
      // Reconstruct the query from positional args (everything not a flag).
      const queryParts: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--scope" || args[i] === "--limit") {
          i++; // skip the value too
          continue;
        }
        queryParts.push(args[i]);
      }
      const query = queryParts.join(" ").trim();
      if (!query) {
        atomsUsage();
        process.exit(1);
      }
      const hits = searchAtoms(query, { scope, limit });
      println(
        chalk.bold(
          `\nsearch results for ${JSON.stringify(query)}${scope ? ` in scope ${scope}` : ""} (top ${limit})`,
        ),
      );
      if (hits.length === 0) {
        println(
          chalk.dim(
            "  (no approved atoms matched — pending atoms are excluded by design)",
          ),
        );
        return;
      }
      println(
        chalk.dim(
          "  rank  id-prefix             scope       tags                              question",
        ),
      );
      hits.forEach((atom, i) => {
        const idShort = atom.id
          .split("-")
          .slice(0, 2)
          .join("-")
          .padEnd(20)
          .slice(0, 20);
        const tags = atom.tags.slice(0, 3).join(", ").padEnd(32).slice(0, 32);
        const q = atom.question.slice(0, 60);
        println(
          `  ${String(i + 1).padStart(4)}  ${idShort}  ${atom.scope.padEnd(10).slice(0, 10)}  ${tags}  ${q}`,
        );
      });
      return;
    }
    case "edit": {
      // pmk gateway atoms edit <id-or-prefix> — open the .md file in
      // $EDITOR (fallback `vi`), validate post-save, atomic replace.
      const [idOrPrefix] = args;
      if (!idOrPrefix) {
        atomsUsage();
        process.exit(1);
      }
      const found = findAtomByPrefix(idOrPrefix);
      if (!found) {
        println(
          chalk.red(
            `no unique match for '${idOrPrefix}'. Try a longer prefix.`,
          ),
        );
        process.exit(1);
      }
      const editor = process.env.EDITOR || process.env.VISUAL || "vi";
      // Backup the original so we can restore on failure.
      const originalContent = fs.readFileSync(found.file, "utf8");
      const backupPath = `${found.file}.editbak`;
      fs.writeFileSync(backupPath, originalContent, "utf8");

      println(
        chalk.dim(
          `opening ${found.file} in ${editor}\n  (post-save: validate front-matter; required fields must keep id/createdAt/question/source)`,
        ),
      );
      const editResult = spawnSync(editor, [found.file], { stdio: "inherit" });
      if (editResult.status !== 0) {
        // User aborted ($EDITOR exited non-zero) — leave file alone.
        fs.unlinkSync(backupPath);
        println(chalk.dim("(editor exited non-zero; no changes made)"));
        return;
      }

      // Re-parse via findAtomByPrefix to validate the post-edit file.
      const reparsed = findAtomByPrefix(found.atom.id);
      if (!reparsed) {
        // Required fields broken; restore.
        fs.writeFileSync(found.file, originalContent, "utf8");
        fs.unlinkSync(backupPath);
        println(
          chalk.red(
            "post-edit validation failed (front-matter unparseable or missing required fields). Restored original.",
          ),
        );
        process.exit(1);
      }
      // Tag/contributor changes are fine; identity must hold.
      if (
        reparsed.atom.id !== found.atom.id ||
        reparsed.atom.createdAt !== found.atom.createdAt
      ) {
        fs.writeFileSync(found.file, originalContent, "utf8");
        fs.unlinkSync(backupPath);
        println(
          chalk.red(
            "post-edit validation failed (id or createdAt changed). Restored original.",
          ),
        );
        process.exit(1);
      }

      fs.unlinkSync(backupPath);
      println(chalk.green(`edited: ${reparsed.atom.id}`));
      return;
    }
    case "approve": {
      const [idOrPrefix] = args;
      if (!idOrPrefix) {
        atomsUsage();
        process.exit(1);
      }
      const atom = approveAtom(idOrPrefix);
      if (!atom) {
        println(
          chalk.red(
            `no unique match for '${idOrPrefix}'. Try a longer prefix.`,
          ),
        );
        process.exit(1);
      }
      println(chalk.green(`approved: ${atom.id}`));
      return;
    }
    case "reject": {
      const [idOrPrefix] = args;
      if (!idOrPrefix) {
        atomsUsage();
        process.exit(1);
      }
      const ok = rejectAtom(idOrPrefix);
      if (!ok) {
        println(
          chalk.red(
            `no unique match for '${idOrPrefix}'. Try a longer prefix.`,
          ),
        );
        process.exit(1);
      }
      println(chalk.green(`rejected (file deleted): ${idOrPrefix}`));
      return;
    }
    case "reindex": {
      // pmk gateway atoms reindex [--scope <name>]
      // Force-rebuild the BM25 index. Auto-rebuild on staleness
      // already happens at search-time, so this is mostly for
      // operators who want to confirm the index is up-to-date or
      // who tweaked PMK_ATOM_VECTOR_THRESHOLD and want to see what
      // would be ranked.
      const scopeIdx = args.indexOf("--scope");
      const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : undefined;
      const before = approvedAtomCount(scope);
      println(
        chalk.dim(
          `building BM25 index over ${before} approved atoms${scope ? ` in scope ${scope}` : ""}…`,
        ),
      );
      const idx = buildAtomsIndex({ scope });
      println(
        chalk.green(
          `indexed ${idx.chunks.length} chunk(s); ranking threshold = ${ATOM_RANKED_THRESHOLD} ` +
            `(${before >= ATOM_RANKED_THRESHOLD ? "BM25 active" : "still using keyword scoring"})`,
        ),
      );
      return;
    }
    default:
      atomsUsage();
      process.exit(1);
  }
}

// v0.9.0 (#31): host-side bootstrap for the Slack admin commands.
// The first admin can only be added from a terminal — there's no
// /pmk admin admins add @first-admin path because no one is yet
// admin to authorise it.

function adminBootstrapUsage(): void {
  println(
    chalk.yellow(
      "usage:\n" +
        "  pmk gateway admin list\n" +
        "  pmk gateway admin add <userId>\n" +
        "  pmk gateway admin remove <userId>\n" +
        "  pmk gateway admin audit [N]   (last N entries from admin.log; default 20)",
    ),
  );
}

function adminBootstrapCmd(rest: string[]): void {
  const [action, target] = rest;
  const cfg = loadGatewayConfig();
  switch (action) {
    case undefined:
    case "list": {
      println(chalk.bold("\npmk gateway admin"));
      if (cfg.admins.length === 0) {
        println(
          chalk.dim(
            "  (none — Slack /pmk admin commands disabled until at least one is added)",
          ),
        );
        println(
          chalk.dim(
            "  add yourself: pmk gateway admin add <your-Slack-userId>",
          ),
        );
        return;
      }
      for (const id of cfg.admins) println(`  ${id}`);
      return;
    }
    case "add": {
      if (!target) {
        adminBootstrapUsage();
        process.exit(1);
      }
      if (!ensureValidSlackUserId(target)) {
        appendAdminLog({
          actor: cliActor(),
          origin: "cli",
          action: "admins.add",
          args: target,
          ok: false,
          reason: "invalid Slack user ID",
        });
        process.exit(1);
      }
      if (cfg.admins.includes(target)) {
        println(chalk.dim(`(${target} already an admin; nothing to do)`));
        return;
      }
      cfg.admins.push(target);
      saveGatewayConfig(cfg);
      println(chalk.green(`added ${target} to admins`));
      appendAdminLog({
        actor: cliActor(),
        origin: "cli",
        action: "admins.add",
        args: target,
        ok: true,
      });
      return;
    }
    case "remove": {
      if (!target) {
        adminBootstrapUsage();
        process.exit(1);
      }
      if (!cfg.admins.includes(target)) {
        println(chalk.dim(`(${target} not in admin list; nothing to do)`));
        return;
      }
      // Last-admin protection — host can lock themselves out otherwise.
      if (cfg.admins.length === 1) {
        println(
          chalk.red(
            `cannot remove ${target}: last remaining admin. Add a replacement first.`,
          ),
        );
        appendAdminLog({
          actor: cliActor(),
          origin: "cli",
          action: "admins.remove",
          args: target,
          ok: false,
          reason: "last-admin protection",
        });
        process.exit(1);
      }
      cfg.admins = cfg.admins.filter((id) => id !== target);
      saveGatewayConfig(cfg);
      println(chalk.green(`removed ${target} from admins`));
      appendAdminLog({
        actor: cliActor(),
        origin: "cli",
        action: "admins.remove",
        args: target,
        ok: true,
      });
      return;
    }
    case "audit": {
      const nArg = target ? Number.parseInt(target, 10) : NaN;
      const n = Number.isFinite(nArg) && nArg > 0 ? nArg : 20;
      // Lazy import so the regular gateway commands don't pull in
      // admin-log unless they need to read it.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { readAdminLog } =
        require("../gateway/admin-log") as typeof import("../gateway/admin-log");
      const entries = readAdminLog(n);
      println(chalk.bold(`\npmk gateway admin audit (last ${entries.length})`));
      if (entries.length === 0) {
        println(chalk.dim("  (no entries yet)"));
        return;
      }
      for (const e of entries) {
        const at = (e as { at?: string }).at?.slice(11, 19) ?? "??:??:??";
        const okMark = e.ok ? chalk.green("ok ") : chalk.red("err");
        const tail = e.args ? ` ${e.args}` : "";
        const reason = !e.ok && e.reason ? chalk.dim(` (${e.reason})`) : "";
        println(
          `  ${at}  ${okMark}  ${e.origin.padEnd(5)}  ${e.actor.padEnd(20).slice(0, 20)}  ${e.action}${tail}${reason}`,
        );
      }
      return;
    }
    default:
      adminBootstrapUsage();
      process.exit(1);
  }
}
