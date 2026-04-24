interface PreviewProps {
  content: string;
}

/**
 * Placeholder for M2. Real Markdown + Mermaid rendering lands in M3.
 */
export function Preview({ content }: PreviewProps) {
  const wordCount = content.trim().split(/\s+/).filter(Boolean).length;
  const firstHeading = content.match(/^#\s+(.+)$/m)?.[1] ?? "(no heading)";

  return (
    <div className="flex h-full flex-col gap-3 p-4 text-xs text-neutral-400">
      <div className="text-[10px] uppercase tracking-widest text-neutral-600">
        Preview
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        <dt className="text-neutral-500">Words</dt>
        <dd>{wordCount.toLocaleString()}</dd>
        <dt className="text-neutral-500">Lines</dt>
        <dd>{content.split("\n").length.toLocaleString()}</dd>
        <dt className="text-neutral-500">Heading</dt>
        <dd className="truncate">{firstHeading}</dd>
      </dl>
      <p className="mt-6 text-[10px] text-neutral-600">
        Full Markdown + Mermaid preview lands in M3.
      </p>
    </div>
  );
}
