import * as path from "node:path";
import chalk from "chalk";
import { loadConfig } from "../config";
import { resolveProviderOrExit } from "../llm";
import { Session } from "../session";
import { PROMPT_PROPOSE } from "../prompts";
import { repl, println, writeToken } from "../io";
import { extractPrdBody, writePrd, nextPrdId } from "../frontmatter";

/**
 * `pmk propose [topic]` — interactive PRD authoring.
 *
 * Multi-turn conversation. Model asks questions; user answers. Exits
 * when the model emits `=== PRD === … === END ===` (saved to
 * `docs/prds/`) or when the user types /done or /quit.
 *
 * Multi-line input: type `/paste`, then any number of lines, then
 * `/send`. The whole block is delivered as one user turn.
 */
export async function proposeCommand(topic?: string): Promise<void> {
  const config = loadConfig();
  const client = resolveProviderOrExit(config);
  const session = new Session();
  const docsDir = path.resolve(process.cwd(), config.docsRoot, "prds");

  println(
    chalk.bold(
      `\npmk propose — model=${config.model} · provider=${client.displayName}`,
    ),
  );
  if (topic) println(chalk.dim(`Seed topic: ${topic}\n`));

  // Seed the conversation and stream the opening assistant turn.
  session.addUser(
    topic
      ? `Help me write a PRD for: ${topic}. Please start asking me questions.`
      : "Start a requirement intake conversation with me. What do you need to know first?",
  );
  process.stdout.write(chalk.gray("assistant> "));
  const opener = await client.chat(PROMPT_PROPOSE, session.history(), {
    onToken: writeToken,
  });
  println("");
  session.addAssistant(opener);

  if (await maybeSavePrd(opener, docsDir)) return;

  await repl(
    async (line) => {
      if (line === "/save") {
        println(
          chalk.yellow(
            "/save not wired yet — ask the model to draft now, e.g. 'ok, draft the PRD'.",
          ),
        );
        return;
      }

      session.addUser(line);
      process.stdout.write(chalk.gray("\nassistant> "));
      const response = await client.chat(PROMPT_PROPOSE, session.history(), {
        onToken: writeToken,
      });
      println("");
      session.addAssistant(response);

      if (await maybeSavePrd(response, docsDir)) return "stop";
    },
    { prompt: "you>", greeting: "" },
  );
}

async function maybeSavePrd(
  response: string,
  docsDir: string,
): Promise<boolean> {
  if (!response.includes("=== PRD ===") || !response.includes("=== END ===")) {
    return false;
  }
  const body = extractPrdBody(response);
  const id = nextPrdId(docsDir);
  const stamped = body.replace(/doc_id:\s*PRD-YYYY-NNNN/g, `doc_id: ${id}`);
  const titleMatch = stamped.match(/^title:\s*(.*)$/m);
  const title = titleMatch ? titleMatch[1].trim() : id;
  const saved = writePrd(stamped, title, docsDir);
  println(chalk.green(`\nPRD saved → ${path.relative(process.cwd(), saved)}`));
  println(chalk.dim(`  doc_id: ${id}`));
  return true;
}
