import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { MermaidBlock } from "./MermaidBlock";

interface PreviewProps {
  content: string;
}

type Mode = "rendered" | "graph";

export function Preview({ content }: PreviewProps) {
  const [mode, setMode] = useState<Mode>("rendered");

  const body = useMemo(() => stripFrontMatter(content), [content]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-neutral-800 px-3 py-2 text-[10px] uppercase tracking-widest text-neutral-500">
        <span className="mr-auto">Preview</span>
        <button
          type="button"
          onClick={() => setMode("rendered")}
          className={
            "rounded px-2 py-0.5 " +
            (mode === "rendered"
              ? "bg-neutral-800 text-white"
              : "text-neutral-500 hover:text-neutral-300")
          }
        >
          rendered
        </button>
        <button
          type="button"
          onClick={() => setMode("graph")}
          className={
            "rounded px-2 py-0.5 " +
            (mode === "graph"
              ? "bg-neutral-800 text-white"
              : "text-neutral-500 hover:text-neutral-300")
          }
        >
          graph
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {mode === "rendered" ? (
          <RenderedPane body={body} />
        ) : (
          <GraphPane content={content} />
        )}
      </div>
    </div>
  );
}

function stripFrontMatter(body: string): string {
  if (!body.startsWith("---")) return body;
  const end = body.indexOf("\n---", 3);
  if (end === -1) return body;
  return body.slice(end + 4).replace(/^\s*\n/, "");
}

function RenderedPane({ body }: { body: string }) {
  return (
    <div className="prose prose-invert prose-sm max-w-none px-5 py-4">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          code({ className, children, ...rest }) {
            if (/language-mermaid/.test(className ?? "")) {
              return (
                <MermaidBlock chart={String(children).replace(/\n$/, "")} />
              );
            }
            return (
              <code className={className} {...rest}>
                {children}
              </code>
            );
          },
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

function GraphPane({ content }: { content: string }) {
  const graph = useMemo(() => buildMermaidFromBacklinks(content), [content]);
  return (
    <div className="px-4 py-4">
      <div className="mb-2 text-[10px] uppercase tracking-widest text-neutral-500">
        Traceability (this doc)
      </div>
      <MermaidBlock chart={graph} />
    </div>
  );
}

/**
 * Render a mini Mermaid graph of *this* doc's `related.*` links only.
 * Full workspace traceability lives in packages/core; wiring the full
 * graph to a desktop pane is a stretch goal — this local view is what
 * M3's Gate asks for.
 */
function buildMermaidFromBacklinks(content: string): string {
  if (!content.startsWith("---")) return 'graph TD\n  n["(no front-matter)"]';
  const end = content.indexOf("\n---", 3);
  if (end === -1) return 'graph TD\n  n["(bad front-matter)"]';
  const fm = content.slice(3, end);

  const docId = fm.match(/^doc_id:\s*(\S+)/m)?.[1] ?? "self";
  const related: Record<string, string[]> = {};
  const rels = fm.match(/^related:([\s\S]*?)(?=^\S|\Z)/m)?.[1] ?? "";
  for (const m of rels.matchAll(/^\s{2,}(\w+):\s*\[([^\]]*)\]/gm)) {
    const kind = m[1];
    const ids = m[2]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    if (ids.length) related[kind] = ids;
  }

  const lines: string[] = ["graph LR", `  self["${docId}"]`];
  let idx = 0;
  for (const [kind, ids] of Object.entries(related)) {
    for (const id of ids) {
      const nodeId = `n${idx++}`;
      lines.push(`  ${nodeId}["${id}"]`);
      lines.push(`  self -- ${kind} --> ${nodeId}`);
    }
  }
  if (idx === 0) lines.push('  empty["(no related entries)"]');
  return lines.join("\n");
}
