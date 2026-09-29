import * as fs from "node:fs";
import * as path from "node:path";
import { listReleases, readLink, releaseDir } from "./paths";

/** ~310 MB per release on the production machine; 3 ≈ 930 MB. */
export const DEFAULT_KEEP = 3;

/** Remove the oldest releases beyond `keep`. `current` and `previous` are never removed. */
export function pruneReleases(root: string, keep: number = DEFAULT_KEEP): string[] {
  const pinned = new Set(
    [readLink(root, "current"), readLink(root, "previous")].filter((n): n is string => n !== undefined),
  );
  const removable = listReleases(root).filter((n) => !pinned.has(n)); // oldest first
  const budget = Math.max(0, keep - pinned.size);
  const drop = removable.slice(0, Math.max(0, removable.length - budget));
  for (const name of drop) fs.rmSync(releaseDir(root, name), { recursive: true, force: true });
  return [...drop, ...pruneStaleTemporaryEntries(root)];
}

/** Only abandoned staging directories and link-swap symlinks older than one hour. */
function pruneStaleTemporaryEntries(root: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const cutoff = Date.now() - 60 * 60_000;
  const removed: string[] = [];
  for (const name of names) {
    if (!/^\.staging-.+/.test(name) && !/^\.(current|previous)\.tmp-.+/.test(name)) continue;
    const entry = path.join(root, name);
    const stat = fs.lstatSync(entry);
    const eligible = name.startsWith(".staging-") ? stat.isDirectory() : stat.isSymbolicLink();
    if (!eligible || stat.mtimeMs >= cutoff) continue;
    fs.rmSync(entry, { recursive: stat.isDirectory(), force: true });
    removed.push(name);
  }
  return removed;
}
