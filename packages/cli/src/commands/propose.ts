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
 * Multi-turn conversation. Model asks questions; user answers.
 * Ends when the model emits `=== PRD ===` ... `=== END ===` or
 * when user types /save.
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

  // Seed the conversation.
  const firstUserMsg = topic
    ? `Help me write a PRD for: ${topic}. Please start asking me questions.`
    : "Start a requirement intake conversation with me. What do you need to know first?";
  session.addUser(firstUserMsg);

  // Outer loop: one LLM turn at a time.
  let done = false;
  let cancelled = false;
  while (!done) {
    process.stdout.write(chalk.gray("\nassistant> "));
    const response = await client.chat(PROMPT_PROPOSE, session.history(), {
      onToken: writeToken,
    });
    println("");
    session.addAssistant(response);

    // If the assistant emitted a PRD, save and exit.
    if (response.includes("=== PRD ===") && response.includes("=== END ===")) {
      const body = extractPrdBody(response);
      const id = nextPrdId(docsDir);
      const stamped = body.replace(/doc_id:\s*PRD-YYYY-NNNN/g, `doc_id: ${id}`);
      const titleMatch = stamped.match(/^title:\s*(.*)$/m);
      const title = titleMatch ? titleMatch[1].trim() : id;
      const saved = writePrd(stamped, title, docsDir);
      println(
        chalk.green(`\nPRD saved → ${path.relative(process.cwd(), saved)}`),
      );
      println(chalk.dim(`  doc_id: ${id}`));
      done = true;
      break;
    }

    // Otherwise, collect another user turn.
    await repl(
      async (line) => {
        if (line === "/save") {
          println(
            chalk.yellow(
              "/save not supported yet — waiting for model to emit `=== PRD ===`. Try asking: 'ok, draft the PRD now'.",
            ),
          );
          return;
        }
        session.addUser(line);
        throw new __EndTurn();
      },
      { prompt: "you>", greeting: "" },
    ).catch((e) => {
      if (e instanceof __EndTurn) return;
      cancelled = true;
    });

    if (cancelled) break;
    // If user typed /done or /quit, repl returned without adding — exit.
    if (session.last("user") === session.history().at(-1)?.content) continue;
    done = true;
  }

  if (cancelled) println(chalk.yellow("\nCancelled."));
}

class __EndTurn extends Error {
  constructor() {
    super("end-turn");
  }
}
