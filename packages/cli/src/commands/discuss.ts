import chalk from "chalk";
import { loadConfig } from "../config";
import { resolveProviderOrExit } from "../llm";
import { Session } from "../session";
import { PROMPT_DISCUSS } from "../prompts";
import { repl, println, writeToken } from "../io";
import { handleParkCommand } from "./_park-hook";

/**
 * `pmk discuss [topic]` — open-ended brainstorm / Q&A.
 * Multi-turn REPL; no file output. Ends on /done or /quit.
 */
export async function discussCommand(topic?: string): Promise<void> {
  const config = loadConfig();
  const client = resolveProviderOrExit(config);
  const session = new Session();

  println(
    chalk.bold(
      `\npmk discuss — model=${config.model} · provider=${client.displayName}`,
    ),
  );
  if (topic) {
    println(chalk.dim(`Topic: ${topic}\n`));
    session.addUser(`Let's discuss: ${topic}`);
    process.stdout.write(chalk.gray("assistant> "));
    const first = await client.chat(PROMPT_DISCUSS, session.history(), {
      onToken: writeToken,
    });
    println("");
    session.addAssistant(first);
  }

  await repl(
    async (line) => {
      if (handleParkCommand(line, session, "discuss", "discuss")) return;
      session.addUser(line);
      process.stdout.write(chalk.gray("\nassistant> "));
      const response = await client.chat(PROMPT_DISCUSS, session.history(), {
        onToken: writeToken,
      });
      println("");
      session.addAssistant(response);
    },
    { prompt: "you>" },
  );
}
