import chalk from "chalk";
import { println } from "../../io";
import { loadGatewayConfig, saveGatewayConfig } from "../../gateway/config";
import { ensureValidSlackUserId } from "./shared";

export function escalationUsage(): void {
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
export function normaliseEscalationScope(scope: string): string | null {
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

export function escalationCmd(rest: string[]): void {
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
