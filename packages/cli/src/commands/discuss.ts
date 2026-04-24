import chalk from "chalk";
import { loadConfig, requireApiKey } from "../config";
import { LlmClient } from "../llm";
import { Session } from "../session";
import { PROMPT_DISCUSS } from "../prompts";
import { repl, println, writeToken } from "../io";

/**
 * `pmk discuss [topic]` — open-ended brainstorm / Q&A.
 * Multi-turn REPL; no file output. Ends on /done or /quit.
 */
export async function discussCommand(topic?: string): Promise<void> {
  const config = loadConfig();
  requireApiKey(config);
  const client = new LlmClient(config);
  const session = new Session();

  println(chalk.bold(`\npmk discuss — model=${config.model}`));
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
