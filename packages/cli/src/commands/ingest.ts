import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { loadConfig, requireApiKey } from "../config";
import { LlmClient } from "../llm";
import { Session } from "../session";
import { PROMPT_INGEST, PROMPT_DISCUSS } from "../prompts";
import { repl, println, writeToken } from "../io";

/**
 * `pmk ingest <path>` — load a file as conversation context, then REPL.
 */
export async function ingestCommand(filePath: string): Promise<void> {
  const config = loadConfig();
  requireApiKey(config);
  const abs = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(abs)) {
    console.error(chalk.red(`[pmk] file not found: ${filePath}`));
    process.exit(1);
  }
  const content = fs.readFileSync(abs, "utf8");
  const client = new LlmClient(config);
  const session = new Session();

  println(chalk.bold(`\npmk ingest — ${path.relative(process.cwd(), abs)}`));
  println(chalk.dim(`${content.split("\n").length} lines, ${content.length} chars\n`));

  session.addUser(
    `I'm ingesting this document for our conversation:\n\n\`\`\`\n${content}\n\`\`\`\n\nPlease acknowledge what this is about in ≤ 3 sentences, then wait for my next question.`,
  );

  process.stdout.write(chalk.gray("assistant> "));
  const ack = await client.chat(PROMPT_INGEST, session.history(), { onToken: writeToken });
  println("");
  session.addAssistant(ack);

  // Switch to discuss-style follow-up.
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
