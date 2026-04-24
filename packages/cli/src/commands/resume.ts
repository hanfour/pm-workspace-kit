import chalk from "chalk";
import { loadConfig } from "../config";
import { resolveProviderOrExit } from "../llm";
import { Session, listParks } from "../session";
import { PROMPTS } from "../prompts";
import { println, repl, writeToken } from "../io";

/**
 * `pmk resume [name]` — reopen a parked session. Without a name, lists
 * available parks. Drops the user back into a REPL with the original
 * system prompt and message history restored.
 */
export async function resumeCommand(name?: string): Promise<void> {
  if (!name) {
    const parks = listParks();
    if (parks.length === 0) {
      println(
        chalk.yellow(
          "No parked sessions. Use `/park <name>` inside any REPL to save.",
        ),
      );
      return;
    }
    println(chalk.bold("Parked sessions:"));
    for (const p of parks) println(`  · ${p}`);
    return;
  }

  let parked;
  try {
    parked = Session.resumeFromPark(name);
  } catch {
    const parks = listParks();
    println(chalk.red(`[pmk] park not found: ${name}`));
    if (parks.length) {
      println(chalk.dim("available parks:"));
      for (const p of parks) println(chalk.dim(`  · ${p}`));
    } else {
      println(
        chalk.dim("no parks exist yet — use /park <name> inside any REPL."),
      );
    }
    process.exit(1);
  }
  const config = loadConfig();
  const client = resolveProviderOrExit(config);
  const session = new Session();
  session.load(parked.messages);

  const systemPrompt =
    (parked.systemPromptKey && PROMPTS[parked.systemPromptKey]) ??
    PROMPTS.discuss;

  println(
    chalk.bold(
      `\npmk resume [${name}] — verb=${parked.verb}, ${parked.messages.length} msgs · provider=${client.displayName}`,
    ),
  );
  println(
    chalk.dim(`parked ${parked.createdAt}, updated ${parked.updatedAt}\n`),
  );

  const last = parked.messages[parked.messages.length - 1];
  if (last?.role === "assistant") {
    println(chalk.gray("(last assistant turn)"));
    println(last.content);
  }

  await repl(
    async (line) => {
      if (line.startsWith("/park ")) {
        const newName = line.slice(6).trim();
        const file = session.park(newName, parked.verb, parked.systemPromptKey);
        println(chalk.green(`\nparked → ${file}`));
        return;
      }
      session.addUser(line);
      process.stdout.write(chalk.gray("\nassistant> "));
      const response = await client.chat(systemPrompt, session.history(), {
        onToken: writeToken,
      });
      println("");
      session.addAssistant(response);
    },
    { prompt: "you>", greeting: "/park <name> to resave, /done to exit" },
  );
}
