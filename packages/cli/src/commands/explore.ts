import { spawn } from "node:child_process";
import * as path from "node:path";
import chalk from "chalk";
import { Session } from "../session";
import {
  buildExploreArgv,
  mraDoctor,
  resolveMraRepo,
} from "../adapters/mra";
import { println } from "../io";

/**
 * `pmk explore <repo>` — delegate deep code exploration to mra.
 *
 * Spawns `mra <repo> --with-deps` with stdio inherited so the user
 * sees mra's output directly. On clean exit, parks the entire
 * conversation transcript so it can be resumed via `pmk resume`.
 *
 * v0.5 design (per PRD-2026-0004): pmk does not intercept mra's REPL
 * output — that would lose features mra ships natively (slash commands,
 * personas, etc.). Instead, pmk owns the lifecycle: pre-flight check,
 * subprocess invocation, post-exit parking.
 */
export async function exploreCommand(repo: string): Promise<void> {
  if (!repo?.trim()) {
    println(chalk.red("usage: pmk explore <repo>"));
    process.exit(1);
  }

  const doctor = mraDoctor();
  if (!doctor.ok) {
    println(chalk.red(`[pmk] ${doctor.reason}`));
    process.exit(1);
  }

  const repoPath = resolveMraRepo(doctor.workspace!, repo);
  if (!repoPath) {
    println(
      chalk.red(
        `[pmk] repo \`${repo}\` not found in workspace ${doctor.workspace}`,
      ),
    );
    process.exit(1);
  }

  println(
    chalk.bold(
      `\npmk explore — delegating to mra ${doctor.version} · workspace=${path.basename(doctor.workspace!)}`,
    ),
  );
  println(chalk.dim(`  binary: ${doctor.binaryPath}`));
  println(chalk.dim(`  repo:   ${repoPath}\n`));

  const argv = buildExploreArgv(repo);
  const child = spawn(doctor.binaryPath!, argv, {
    cwd: doctor.workspace!,
    stdio: "inherit",
    env: process.env,
  });

  // Park a stub session so `pmk resume` lists this run, even though
  // we don't capture mra's actual transcript (that lives in mra's
  // own session log).
  const session = new Session();
  session.addUser(`pmk explore ${repo}`);
  session.addAssistant(
    `Delegated to mra ${doctor.version} on ${repoPath}. ` +
      `Full transcript in mra's session log.`,
  );

  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code, signal) => {
      const parkName = `explore-${repo.replace(/[^A-Za-z0-9_.-]+/g, "-")}`;
      try {
        const file = session.park(parkName, "explore", "discuss");
        println(chalk.green(`\nparked → ${file}`));
        println(chalk.dim(`  resume with: pmk resume ${parkName}`));
      } catch (err) {
        println(
          chalk.yellow(`(could not park: ${(err as Error).message})`),
        );
      }
      if (code !== 0) {
        process.exit(code ?? 1);
      }
      if (signal) reject(new Error(`mra exited via signal ${signal}`));
      else resolve();
    });
    child.on("error", (err) => reject(err));
  });
}
