import * as readline from "node:readline/promises";
import chalk from "chalk";

/**
 * Interactive single-line prompt.
 */
export async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await rl.question(chalk.cyan(`${question} `));
  } finally {
    rl.close();
  }
}

/**
 * Multi-turn REPL. Returns when the user types /done, /quit, or Ctrl-D.
 */
export async function repl(
  onUserLine: (line: string) => Promise<void>,
  opts: { prompt?: string; greeting?: string } = {},
): Promise<void> {
  const prompt = opts.prompt ?? "you>";
  const greeting = opts.greeting ?? "Type /done when finished, /quit to exit.";
  console.log(chalk.dim(greeting));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  while (true) {
    const line = await rl.question(chalk.cyan(`${prompt} `));
    const trimmed = line.trim();
    if (trimmed === "/done" || trimmed === "/quit") break;
    if (!trimmed) continue;
    try {
      await onUserLine(trimmed);
    } catch (err) {
      console.error(chalk.red(`error: ${(err as Error).message}`));
    }
  }
  rl.close();
}

export function println(text: string): void {
  process.stdout.write(text + "\n");
}

export function writeToken(chunk: string): void {
  process.stdout.write(chunk);
}
