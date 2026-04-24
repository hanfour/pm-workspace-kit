import * as readline from "node:readline/promises";
import chalk from "chalk";

/**
 * Return value contract for repl callbacks.
 * - `void` (default) — keep prompting.
 * - `"stop"`         — close the REPL and return from repl().
 */
export type ReplCallbackResult = void | "stop";

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
 * Multi-turn REPL.
 *
 * Exits when:
 *   - user types /done, /quit, or presses Ctrl-D
 *   - the callback returns "stop"
 *
 * Supports `/paste` … `/send` for multi-line input — accumulates every
 * line until the user types `/send` (or `/cancel` to discard), then
 * delivers the whole block as a single callback invocation.
 */
export async function repl(
  onUserLine: (line: string) => Promise<ReplCallbackResult>,
  opts: { prompt?: string; greeting?: string } = {},
): Promise<void> {
  const prompt = opts.prompt ?? "you>";
  const greeting =
    opts.greeting ??
    "Type /done to exit, /paste for multi-line input, /quit to abort.";
  console.log(chalk.dim(greeting));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  try {
    while (true) {
      const raw = await rl.question(chalk.cyan(`${prompt} `));
      const trimmed = raw.trim();
      if (trimmed === "/done" || trimmed === "/quit") break;
      if (!trimmed) continue;

      let payload: string;
      if (trimmed === "/paste") {
        const composed = await collectPaste(rl);
        if (composed === null) {
          console.log(chalk.dim("(paste cancelled)"));
          continue;
        }
        payload = composed;
      } else {
        payload = trimmed;
      }

      try {
        const result = await onUserLine(payload);
        if (result === "stop") break;
      } catch (err) {
        console.error(chalk.red(`error: ${(err as Error).message}`));
      }
    }
  } finally {
    rl.close();
  }
}

async function collectPaste(
  rl: readline.Interface,
): Promise<string | null> {
  console.log(
    chalk.dim("Paste / type below. End with `/send`, cancel with `/cancel`."),
  );
  const lines: string[] = [];
  while (true) {
    const raw = await rl.question(chalk.cyan("… "));
    const trimmed = raw.trim();
    if (trimmed === "/send") return lines.join("\n").trim() || null;
    if (trimmed === "/cancel") return null;
    lines.push(raw);
  }
}

export function println(text: string): void {
  process.stdout.write(text + "\n");
}

export function writeToken(chunk: string): void {
  process.stdout.write(chunk);
}
