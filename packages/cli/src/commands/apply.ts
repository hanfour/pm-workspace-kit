import chalk from "chalk";
import { println } from "../io";

/**
 * `pmk apply <plan>` — execute decomposed tasks from a plan.
 * Stub for M1; full decomposition engine lands in M5.
 */
export async function applyCommand(plan?: string): Promise<void> {
  println(chalk.yellow("pmk apply — not implemented in M1."));
  println(
    chalk.dim(
      "Coming in M5 (parallel task execution). Tracked in the sprint plan.\n" +
        "For now, use `pmk discuss` to walk through a plan manually.",
    ),
  );
  if (plan) println(chalk.dim(`(requested plan: ${plan})`));
  process.exit(2);
}
