import chalk from "chalk";
import { println } from "../io";

/**
 * `pmk ask "question"` — RAG query over the corpus.
 * Stub for M1; implementation in M4 (packages/rag).
 */
export async function askCommand(question?: string): Promise<void> {
  println(chalk.yellow("pmk ask — not implemented in M1."));
  println(
    chalk.dim(
      "RAG index lands in M4. See apps/docs/docs/plans/2026-04-24-desktop-app-sprint-plan.md.\n" +
        "For now, use `pmk discuss` or `pmk ingest <file>` to bring context into a session.",
    ),
  );
  if (question) println(chalk.dim(`(you asked: ${question})`));
  process.exit(2);
}
