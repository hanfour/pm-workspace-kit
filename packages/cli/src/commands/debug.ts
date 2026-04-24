import chalk from "chalk";
import { loadConfig } from "../config";
import { resolveProviderOrExit } from "../llm";
import { Session } from "../session";
import { PROMPT_DEBUG } from "../prompts";
import { repl, println, writeToken } from "../io";
import { handleParkCommand } from "./_park-hook";

/**
 * `pmk debug [symptom]` — systematic debugging flow.
 * Full implementation; uses the debug system prompt to enforce the
 * "symptom → repro → hypotheses → test one → iterate" framework.
 */
export async function debugCommand(symptom?: string): Promise<void> {
  const config = loadConfig();
  const client = resolveProviderOrExit(config);
  const session = new Session();

  println(
    chalk.bold(
      `\npmk debug — model=${config.model} · provider=${client.displayName}`,
    ),
  );

  const opener = symptom
    ? `I'm seeing this issue: ${symptom}. Help me debug systematically.`
    : "I'm debugging something but I'm not sure where to start. Please guide me.";
  session.addUser(opener);

  process.stdout.write(chalk.gray("assistant> "));
  const first = await client.chat(PROMPT_DEBUG, session.history(), {
    onToken: writeToken,
  });
  println("");
  session.addAssistant(first);

  await repl(
    async (line) => {
      if (handleParkCommand(line, session, "debug", "debug")) return;
      session.addUser(line);
      process.stdout.write(chalk.gray("\nassistant> "));
      const response = await client.chat(PROMPT_DEBUG, session.history(), {
        onToken: writeToken,
      });
      println("");
      session.addAssistant(response);
    },
    { prompt: "you>" },
  );
}
