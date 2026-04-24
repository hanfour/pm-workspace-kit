import * as path from "node:path";
import { execFileSync } from "node:child_process";
import chalk from "chalk";
import { println } from "../io";

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * `pmk worktree` — thin wrapper over `git worktree` tailored for
 * parallel pmk sessions. Each worktree gets its own branch and
 * directory, so several agents (or one PM) can iterate independently
 * without stepping on each other's working tree.
 */
export async function worktreeCommand(
  action: string,
  rest: string[],
): Promise<void> {
  switch (action) {
    case "add": {
      const branch = rest[0];
      if (!branch) {
        println(chalk.red("usage: pmk worktree add <branch> [path]"));
        process.exit(1);
      }
      const dir = rest[1] ?? path.resolve("..", `pmk-${branch.replace(/[^a-zA-Z0-9_-]/g, "-")}`);
      println(chalk.dim(`creating worktree at ${dir} on branch ${branch}…`));
      try {
        git(["worktree", "add", "-b", branch, dir]);
        println(chalk.green(`worktree created → ${dir}`));
      } catch (err) {
        // Branch may already exist → fall back to no -b.
        try {
          git(["worktree", "add", dir, branch]);
          println(chalk.green(`worktree attached → ${dir} (branch ${branch})`));
        } catch {
          println(chalk.red(`failed: ${(err as Error).message}`));
          process.exit(1);
        }
      }
      break;
    }
    case "list": {
      println(git(["worktree", "list"]).trimEnd());
      break;
    }
    case "remove": {
      const dir = rest[0];
      if (!dir) {
        println(chalk.red("usage: pmk worktree remove <path>"));
        process.exit(1);
      }
      git(["worktree", "remove", dir]);
      println(chalk.green(`removed → ${dir}`));
      break;
    }
    default:
      println(chalk.yellow("usage: pmk worktree <add|list|remove> [...]"));
      process.exit(1);
  }
}
