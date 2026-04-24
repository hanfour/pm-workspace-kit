import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { loadConfig } from "../config";
import { resolveProviderOrExit } from "../llm";
import { Session } from "../session";
import { PROMPT_APPLY } from "../prompts";
import { ask, println, writeToken } from "../io";

export interface ApplyOptions {
  parallel?: boolean;
}

interface Task {
  line: string;
  text: string;
  done: boolean;
}

function parsePlan(body: string): Task[] {
  const tasks: Task[] = [];
  const lines = body.split("\n");
  for (const raw of lines) {
    const m = raw.match(/^\s*[-*]\s*\[( |x|X)\]\s*(.+?)\s*$/);
    if (!m) continue;
    tasks.push({
      line: raw,
      text: m[2],
      done: m[1].toLowerCase() === "x",
    });
  }
  return tasks;
}

/**
 * `pmk apply <plan>` — walk a Markdown plan, executing each unchecked
 * task with per-task confirmation. `--parallel` runs every unchecked
 * task concurrently for preview/dry-run — the output is streamed but
 * not written back; the user decides what to commit.
 */
export async function applyCommand(
  plan?: string,
  opts: ApplyOptions = {},
): Promise<void> {
  if (!plan) {
    println(chalk.red("usage: pmk apply <plan.md> [--parallel]"));
    process.exit(1);
  }
  const abs = path.resolve(process.cwd(), plan);
  if (!fs.existsSync(abs)) {
    println(chalk.red(`[pmk] plan not found: ${plan}`));
    process.exit(1);
  }
  const body = fs.readFileSync(abs, "utf8");
  const tasks = parsePlan(body).filter((t) => !t.done);
  if (tasks.length === 0) {
    println(chalk.yellow("[pmk] no outstanding `- [ ]` tasks in plan."));
    return;
  }

  const config = loadConfig();
  const client = resolveProviderOrExit(config);
  println(
    chalk.bold(
      `\npmk apply — ${tasks.length} task(s)${opts.parallel ? " (parallel)" : " (sequential)"} · provider=${client.displayName}`,
    ),
  );

  if (opts.parallel) {
    await Promise.all(
      tasks.map(async (t, i) => {
        const session = new Session();
        session.addUser(
          `Task ${i + 1}/${tasks.length}: ${t.text}\n\nPropose the minimum implementation, no preamble. Output code or concrete actions.`,
        );
        const label = chalk.cyan(`[${i + 1}]`);
        println(`${label} start: ${t.text}`);
        const response = await client.chat(PROMPT_APPLY, session.history(), {
          onToken: () => {},
        });
        println(`\n${label} ${chalk.bold("proposal:")}`);
        for (const line of response.split("\n"))
          println(`${label} ${line}`);
      }),
    );
    println(chalk.dim("\n(parallel mode — nothing written; review output and run sequentially to apply)"));
    return;
  }

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const session = new Session();
    session.addUser(
      `Task ${i + 1}/${tasks.length}: ${t.text}\n\nWalk me through: (1) restate the task, (2) propose the minimum change, (3) wait for my "ok" to produce the artifact.`,
    );
    println(chalk.bold(`\n─── Task ${i + 1}: ${t.text} ───`));
    process.stdout.write(chalk.gray("assistant> "));
    const first = await client.chat(PROMPT_APPLY, session.history(), {
      onToken: writeToken,
    });
    println("");
    session.addAssistant(first);

    const choice = (await ask("proceed (p) / skip (s) / abort (a):")).trim().toLowerCase();
    if (choice === "a") {
      println(chalk.yellow("aborted."));
      return;
    }
    if (choice === "s") continue;

    session.addUser("ok, produce the artifact now.");
    process.stdout.write(chalk.gray("\nassistant> "));
    await client.chat(PROMPT_APPLY, session.history(), { onToken: writeToken });
    println("");
  }
  println(chalk.green("\n[pmk] plan walked through. Remember to commit."));
}
