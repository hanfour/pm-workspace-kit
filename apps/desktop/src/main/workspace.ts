import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Find the nearest ancestor directory that contains a `.git` folder.
 * Falls back to the starting directory if none is found.
 */
export function findRepoRoot(start: string = process.cwd()): string {
  let cur = resolve(start);
  while (true) {
    if (existsSync(resolve(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return start;
    cur = parent;
  }
}
