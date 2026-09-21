import * as fs from "node:fs";
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
  return drop;
}
