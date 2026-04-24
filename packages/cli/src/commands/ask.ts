import * as path from "node:path";
import * as fs from "node:fs";
import chalk from "chalk";
import { formatContext, loadIndex, query } from "@pmk/rag";
import { loadConfig } from "../config";
import { resolveProviderOrExit } from "../llm";
import { Session } from "../session";
import { PROMPT_ASK } from "../prompts";
import { println, writeToken } from "../io";

function findIndexPath(cwd: string = process.cwd()): string | null {
  let cur = path.resolve(cwd);
  while (true) {
    const candidate = path.join(cur, ".pmk", "rag-index.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * `pmk ask "question"` — retrieval + answer over the local docs corpus.
 * Requires an existing index built by `pmk index`.
 */
export async function askCommand(question?: string): Promise<void> {
  if (!question?.trim()) {
    println(chalk.red("[pmk] ask needs a question. Usage: pmk ask \"what is …\""));
    process.exit(1);
  }

  const indexPath = findIndexPath();
  if (!indexPath) {
    println(
      chalk.red(
        "[pmk] no RAG index found. Run `pmk index` in your workspace first.",
      ),
    );
    process.exit(1);
  }
  const index = loadIndex(indexPath);
  if (!index) {
    println(chalk.red(`[pmk] index at ${indexPath} is unreadable.`));
    process.exit(1);
  }

  const config = loadConfig();
  const client = resolveProviderOrExit(config);

  const results = query(index, question, 6);
  println(
    chalk.dim(
      `retrieved ${results.length} chunk(s) from ${index.chunks.length} indexed`,
    ),
  );

  const context = formatContext(results);
  const session = new Session();
  session.addUser(
    context
      ? `Workspace context:\n\n${context}\n\nQuestion: ${question}`
      : `Question (no matching docs found): ${question}`,
  );

  process.stdout.write(chalk.gray("\nassistant> "));
  await client.chat(PROMPT_ASK, session.history(), { onToken: writeToken });
  println("");

  if (results.length) {
    println(chalk.dim("\nsources:"));
    for (const r of results) {
      println(
        chalk.dim(
          `  · ${r.chunk.path}${r.chunk.heading ? ` → ${r.chunk.heading}` : ""} (score ${r.score.toFixed(2)})`,
        ),
      );
    }
  }
}
