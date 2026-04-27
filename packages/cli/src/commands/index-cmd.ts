import * as path from "node:path";
import * as fs from "node:fs";
import chalk from "chalk";
import { indexDocs, saveIndex } from "@pmk/rag";
import { println } from "../io";

function findRepoRoot(cwd: string = process.cwd()): string {
  let cur = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return cwd;
    cur = parent;
  }
}

/**
 * `pmk index` — build (or rebuild) the RAG index over the current
 * workspace. Writes `.pmk/rag-index.json` at the repo root.
 */
export async function indexCommand(
  opts: { root?: string } = {},
): Promise<void> {
  const root = path.resolve(opts.root ?? findRepoRoot());
  println(chalk.bold(`pmk index — scanning ${root}`));
  const t0 = Date.now();
  const index = await indexDocs(root);
  const out = path.join(root, ".pmk", "rag-index.json");
  saveIndex(index, out);
  println(
    chalk.green(
      `\nindexed ${index.chunks.length} chunks in ${Date.now() - t0} ms`,
    ),
  );
  println(chalk.dim(`→ ${path.relative(process.cwd(), out)}`));
}
