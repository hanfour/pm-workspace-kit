import chalk from "chalk";
import { loadConfig } from "../config";
import { resolveProviderOrExit } from "../llm";
import { Session } from "../session";
import { PROMPT_TDD } from "../prompts";
import { println, repl, writeToken } from "../io";
import { handleParkCommand } from "./park-hook";

/**
 * `pmk tdd [feature]` — guided Red → Green → Refactor loop.
 * The system prompt enforces phase discipline; this command is just
 * a thin REPL wrapper.
 */
export async function tddCommand(feature?: string): Promise<void> {
  const config = loadConfig();
  const client = resolveProviderOrExit(config);
  const session = new Session();

  println(
    chalk.bold(
      `\npmk tdd — model=${config.model} · provider=${client.displayName}`,
    ),
  );

  session.addUser(
    feature
      ? `I want to TDD: ${feature}. Propose the first failing test (Red phase).`
      : "Please start a TDD session with me. Ask what I'm building, then propose the first failing test.",
  );
  process.stdout.write(chalk.gray("assistant> "));
  const first = await client.chat(PROMPT_TDD, session.history(), {
    onToken: writeToken,
  });
  println("");
  session.addAssistant(first);

  await repl(
    async (line) => {
      if (handleParkCommand(line, session, "tdd", "tdd")) return;
      session.addUser(line);
      process.stdout.write(chalk.gray("\nassistant> "));
      const response = await client.chat(PROMPT_TDD, session.history(), {
        onToken: writeToken,
      });
      println("");
      session.addAssistant(response);
    },
    { prompt: "you>" },
  );
}
