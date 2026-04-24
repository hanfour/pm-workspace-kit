import { ipcMain } from "electron";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { simpleGit } from "simple-git";

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  tracked: boolean;
  children?: TreeNode[];
}

const IGNORED = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  ".docusaurus",
]);

/**
 * Synchronous containment check: resolve `target` as absolute and
 * confirm it sits under `root`. Rejects `..`, unrelated absolute paths,
 * and sibling dirs with a shared prefix (`/a/root` vs `/a/roots`).
 *
 * Does NOT resolve symlinks — use `ensureInsideReal` for IPC that
 * hands paths to the filesystem. Kept sync + export so tests don't
 * need an async harness.
 */
export function ensureInside(root: string, target: string): string {
  const abs = resolve(target);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || resolve(root, rel) !== abs) {
    throw new Error(`path escapes workspace: ${target}`);
  }
  return abs;
}

/**
 * Like `ensureInside` but also resolves symlinks via `fs.realpath` so
 * an in-workspace symlink cannot point at a file outside the root.
 * Falls back to the synchronous check when the target doesn't exist
 * yet (writeFile creating a new file), since `realpath` would throw.
 */
export async function ensureInsideReal(
  root: string,
  target: string,
): Promise<string> {
  const abs = ensureInside(root, target);
  if (!existsSync(abs)) return abs;
  const real = await realpath(abs);
  const realRoot = existsSync(root) ? await realpath(root) : root;
  const rel = relative(realRoot, real);
  if (rel.startsWith("..") || resolve(realRoot, rel) !== real) {
    throw new Error(`path escapes workspace via symlink: ${target}`);
  }
  return real;
}

async function buildTree(
  root: string,
  dir: string,
  tracked: Set<string>,
  depth: number,
): Promise<TreeNode[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: TreeNode[] = [];
  for (const e of entries) {
    if (IGNORED.has(e.name)) continue;
    if (e.name.startsWith(".") && e.name !== ".github") continue;
    const abs = join(dir, e.name);
    const rel = relative(root, abs);
    if (e.isDirectory()) {
      const children =
        depth < 6 ? await buildTree(root, abs, tracked, depth + 1) : [];
      if (children.length === 0 && depth > 0) {
        // collapse empty dirs one level down to keep the tree tidy
      }
      out.push({
        name: e.name,
        path: abs,
        type: "directory",
        tracked: true,
        children,
      });
    } else if (e.isFile()) {
      out.push({
        name: e.name,
        path: abs,
        type: "file",
        tracked: tracked.has(rel),
      });
    }
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

export function registerFsHandlers(repoRoot: string): void {
  ipcMain.handle("pmk:fs:listWorkspace", async () => {
    const git = simpleGit(repoRoot);
    let tracked = new Set<string>();
    try {
      const lsFiles = await git.raw(["ls-files"]);
      tracked = new Set(lsFiles.split("\n").filter(Boolean));
    } catch {
      // not a git repo — everything is "untracked"
    }
    const entries = await buildTree(repoRoot, repoRoot, tracked, 0);
    return { cwd: repoRoot, entries };
  });

  ipcMain.handle("pmk:fs:readFile", async (_e, path: string) => {
    const abs = await ensureInsideReal(repoRoot, path);
    return await readFile(abs, "utf8");
  });

  ipcMain.handle(
    "pmk:fs:writeFile",
    async (_e, path: string, content: string) => {
      const abs = await ensureInsideReal(repoRoot, path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      const s = await stat(abs);
      return { size: s.size, mtime: s.mtimeMs };
    },
  );
}
