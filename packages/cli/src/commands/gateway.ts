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
    default:
      println(
        chalk.yellow(
          "usage: pmk gateway <init|start|status|stats|audience|escalation|atoms>",
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
        "  pmk gateway audience set <userId> <tech|pm|biz|exec>\n" +
        "  pmk gateway audience unset <userId>\n" +
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
