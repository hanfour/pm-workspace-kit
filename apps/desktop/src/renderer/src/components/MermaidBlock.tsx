import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  securityLevel: "strict",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
});

let seq = 0;

interface MermaidBlockProps {
  chart: string;
}

export function MermaidBlock({ chart }: MermaidBlockProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid-${++seq}`;
    mermaid
      .render(id, chart)
      .then(({ svg }) => {
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = svg;
        setErr(null);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setErr(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [chart]);

  if (err) {
    return (
      <div className="rounded border border-red-900 bg-red-950/40 p-3 text-xs text-red-300">
        mermaid error: {err}
      </div>
    );
  }
  return <div ref={ref} className="overflow-x-auto" />;
}
