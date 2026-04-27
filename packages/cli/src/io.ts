import * as readline from "node:readline/promises";
import chalk from "chalk";

/**
 * Return value contract for repl callbacks.
 * - `void` (default) — keep prompting.
 * - `"stop"`         — close the REPL and return from repl().
 */
export type ReplCallbackResult = void | "stop";

/**
 * Single-line prompt.
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
 * Multi-turn REPL with automatic paste detection.
 *
 * How dispatch works:
 *   - Each `line` event is buffered.
 *   - A 30 ms flush timer is armed after the first line.
 *   - Terminal paste delivers every line synchronously inside one event
 *     loop tick, so the buffer accumulates before the timer fires → the
 *     whole block is dispatched as ONE callback invocation.
 *   - Human typing has multi-second gaps between Enters, so each manual
 *     line flushes on its own.
 *
 * Exits when the user types /done, /quit, hits Ctrl-D, or the callback
 * returns "stop".
 */
export async function repl(
  onUserLine: (line: string) => Promise<ReplCallbackResult>,
  opts: { prompt?: string; greeting?: string } = {},
): Promise<void> {
  const promptLabel = opts.prompt ?? "you>";
  const greeting =
    opts.greeting ?? "Type /done to exit. Paste is auto-detected.";
  console.log(chalk.dim(greeting));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const renderPrompt = () =>
    process.stdout.write(chalk.cyan(`${promptLabel} `));
  renderPrompt();

  let buffer: string[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let busy = false;
  let closed = false;

  const flush = async () => {
    flushTimer = null;
    if (busy) return;
    const combined = buffer.join("\n").trim();
    buffer = [];
    if (!combined) {
      renderPrompt();
      return;
    }
    if (combined === "/done" || combined === "/quit") {
      rl.close();
      return;
    }
    busy = true;
    rl.pause();
    try {
      const result = await onUserLine(combined);
      if (result === "stop") {
        rl.close();
        return;
      }
    } catch (err) {
      console.error(chalk.red(`error: ${(err as Error).message}`));
    } finally {
      busy = false;
      if (!closed) rl.resume();
    }
    if (!closed) renderPrompt();
  };

  rl.on("line", (line) => {
    buffer.push(line);
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      void flush();
    }, 30);
  });

  await new Promise<void>((resolve) => {
    rl.once("close", () => {
      closed = true;
      if (flushTimer) clearTimeout(flushTimer);
      resolve();
    });
  });
}

export function println(text: string): void {
  process.stdout.write(text + "\n");
}

export function writeToken(chunk: string): void {
  process.stdout.write(chunk);
}
