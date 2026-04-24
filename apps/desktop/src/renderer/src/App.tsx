import { useState } from "react";
import { FileTree } from "./components/FileTree";
import { Editor } from "./components/Editor";
import { Preview } from "./components/Preview";
import { FirstRun } from "./components/FirstRun";
import "./pmk.d.ts";

export function App() {
  const [path, setPath] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [provider, setProvider] = useState<string | null>(null);

  return (
    <div className="relative grid h-screen grid-cols-[260px_1fr_360px] grid-rows-[1fr_auto] bg-neutral-950 text-neutral-100">
      <FirstRun onResolved={setProvider} />
      <aside className="row-start-1 overflow-auto border-r border-neutral-800">
        <FileTree
          onOpen={(p, body) => {
            setPath(p);
            setContent(body);
            setDirty(false);
          }}
          activePath={path}
        />
      </aside>

      <main className="row-start-1 flex min-w-0 flex-col">
        <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-2 text-xs text-neutral-400">
          <span className="truncate">
            {path ?? "No file open"}
            {dirty && <span className="ml-2 text-amber-400">● unsaved</span>}
          </span>
          <button
            type="button"
            disabled={!path || !dirty}
            onClick={async () => {
              if (!path) return;
              await window.pmk?.fs.writeFile(path, content);
              setDirty(false);
            }}
            className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 enabled:hover:bg-neutral-800 disabled:opacity-40"
          >
            Save (⌘S)
          </button>
        </header>
        <div className="min-h-0 flex-1">
          <Editor
            value={content}
            path={path}
            onChange={(next) => {
              setContent(next);
              setDirty(true);
            }}
            onSaveShortcut={async () => {
              if (!path || !dirty) return;
              await window.pmk?.fs.writeFile(path, content);
              setDirty(false);
            }}
          />
        </div>
      </main>

      <aside className="row-start-1 overflow-auto border-l border-neutral-800">
        <Preview content={content} />
      </aside>

      <footer className="col-span-3 row-start-2 border-t border-neutral-800 px-4 py-1 text-[10px] text-neutral-500">
        pmk desktop · M2 scaffold · provider: {provider ?? "—"}
      </footer>
    </div>
  );
}
