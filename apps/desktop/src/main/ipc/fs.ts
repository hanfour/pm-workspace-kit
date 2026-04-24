import { ipcMain } from "electron";
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
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
 * Resolve `target` as absolute and confirm it sits under `root`. Throws
 * if the resolved path escapes the workspace (via `..`, absolute paths,
 * symlink-like tricks). Exported so tests can exercise the defence
 * without standing up an Electron process.
 */
export function ensureInside(root: string, target: string): string {
  const abs = resolve(target);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || resolve(root, rel) !== abs) {
    throw new Error(`path escapes workspace: ${target}`);
  }
  return abs;
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
    const abs = ensureInside(repoRoot, path);
    return await readFile(abs, "utf8");
  });

  ipcMain.handle(
    "pmk:fs:writeFile",
    async (_e, path: string, content: string) => {
      const abs = ensureInside(repoRoot, path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      const s = await stat(abs);
      return { size: s.size, mtime: s.mtimeMs };
    },
  );
}
