import { useCallback, useEffect, useState } from "react";

interface FileTreeProps {
  onOpen: (path: string, content: string) => void;
  activePath: string | null;
}

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  tracked: boolean;
  children?: TreeNode[];
}

export function FileTree({ onOpen, activePath }: FileTreeProps) {
  const [root, setRoot] = useState<TreeNode[] | null>(null);
  const [cwd, setCwd] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!window.pmk) {
      setError("preload bridge missing");
      return;
    }
    try {
      const { cwd, entries } = await window.pmk.fs.listWorkspace();
      setCwd(cwd);
      setRoot(entries);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openFile = async (path: string) => {
    const body = await window.pmk!.fs.readFile(path);
    onOpen(path, body);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-neutral-800 px-3 py-2">
        <div className="text-[10px] uppercase tracking-widest text-neutral-600">
          Workspace
        </div>
        <div className="truncate text-xs text-neutral-400" title={cwd}>
          {cwd || "(loading…)"}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1 text-sm">
        {error && <div className="px-3 py-2 text-red-400">{error}</div>}
        {root && (
          <TreeList
            nodes={root}
            onOpen={openFile}
            activePath={activePath}
            depth={0}
          />
        )}
      </div>
    </div>
  );
}

function TreeList({
  nodes,
  onOpen,
  activePath,
  depth,
}: {
  nodes: TreeNode[];
  onOpen: (path: string) => void;
  activePath: string | null;
  depth: number;
}) {
  return (
    <ul className="list-none">
      {nodes.map((n) => (
        <TreeItem
          key={n.path}
          node={n}
          onOpen={onOpen}
          activePath={activePath}
          depth={depth}
        />
      ))}
    </ul>
  );
}

function TreeItem({
  node,
  onOpen,
  activePath,
  depth,
}: {
  node: TreeNode;
  onOpen: (path: string) => void;
  activePath: string | null;
  depth: number;
}) {
  const [open, setOpen] = useState(depth < 1);
  const isActive = node.path === activePath;
  const indent = { paddingLeft: `${depth * 14 + 10}px` };

  if (node.type === "directory") {
    return (
      <li>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          style={indent}
          className="flex w-full items-center gap-1 py-0.5 text-left text-neutral-300 hover:bg-neutral-800"
        >
          <span className="text-neutral-500">{open ? "▾" : "▸"}</span>
          <span>{node.name}</span>
        </button>
        {open && node.children && (
          <TreeList
            nodes={node.children}
            onOpen={onOpen}
            activePath={activePath}
            depth={depth + 1}
          />
        )}
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(node.path)}
        style={indent}
        className={
          "flex w-full items-center gap-1 py-0.5 text-left hover:bg-neutral-800 " +
          (isActive
            ? "bg-neutral-800 text-white"
            : node.tracked
              ? "text-neutral-300"
              : "text-amber-400/80")
        }
        title={node.tracked ? node.path : `${node.path} (untracked)`}
      >
        <span className="text-neutral-600">·</span>
        <span className="truncate">{node.name}</span>
      </button>
    </li>
  );
}
