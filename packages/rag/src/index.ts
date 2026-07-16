import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";
import { tokenize } from "./tokenize";

export interface Chunk {
  id: string;
  path: string;
  docId?: string;
  title?: string;
  heading?: string;
  text: string;
}

export interface IndexedChunk extends Chunk {
  tf: Record<string, number>;
  length: number;
}

export interface RagIndex {
  version: 1;
  builtAt: string;
  root: string;
  chunks: IndexedChunk[];
  idf: Record<string, number>;
  /**
   * Number of source files scanned at build time. Consumers that cache the
   * index compare this against a fresh scan to invalidate on file ADDITIONS
   * and DELETIONS — deletions never bump any surviving file's mtime, so an
   * mtime-only check can't catch them. Optional: indexes persisted by older
   * versions lack it (treat as stale once and rebuild).
   */
  fileCount?: number;
}

const DEFAULT_EXTS = [".md", ".mdx"];
const CHUNK_TARGET_LEN = 1200;
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".docusaurus",
  ".cache",
  ".turbo",
]);

export async function indexDocs(
  root: string,
  opts: { exts?: string[]; signal?: AbortSignal } = {},
): Promise<RagIndex> {
  const exts = opts.exts ?? DEFAULT_EXTS;
  const chunks: Chunk[] = [];
  const files = walkFiles(root, exts);
  for (const abs of files) {
    if (opts.signal?.aborted) throw new Error("indexDocs aborted");
    const raw = fs.readFileSync(abs, "utf8");
    const parsed = matter(raw);
    const data = parsed.data as Record<string, unknown>;
    const baseMeta = {
      path: path.relative(root, abs),
      docId: typeof data.doc_id === "string" ? data.doc_id : undefined,
      title: typeof data.title === "string" ? data.title : undefined,
    };
    for (const piece of chunkMarkdown(parsed.content)) {
      chunks.push({
        id: `${baseMeta.path}#${chunks.length}`,
        ...baseMeta,
        heading: piece.heading,
        text: piece.text,
      });
    }
  }

  const indexed: IndexedChunk[] = chunks.map((c) => {
    const tokens = tokenize(c.text);
    const tf: Record<string, number> = {};
    for (const tok of tokens) tf[tok] = (tf[tok] ?? 0) + 1;
    return { ...c, tf, length: tokens.length };
  });

  const df: Record<string, number> = {};
  for (const c of indexed) {
    for (const tok of Object.keys(c.tf)) df[tok] = (df[tok] ?? 0) + 1;
  }
  const N = Math.max(indexed.length, 1);
  const idf: Record<string, number> = {};
  for (const [tok, count] of Object.entries(df)) {
    idf[tok] = Math.log((N - count + 0.5) / (count + 0.5) + 1);
  }

  return {
    version: 1,
    builtAt: new Date().toISOString(),
    root,
    chunks: indexed,
    idf,
  };
}

export function saveIndex(index: RagIndex, file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(index), "utf8");
}

export function loadIndex(file: string): RagIndex | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as RagIndex;
  } catch {
    return null;
  }
}

export interface QueryResult {
  chunk: IndexedChunk;
  score: number;
}

/**
 * BM25-scored query. Returns top-k chunks by relevance.
 */
export function query(
  index: RagIndex,
  question: string,
  k = 6,
): QueryResult[] {
  const tokens = tokenize(question);
  const unique = Array.from(new Set(tokens));
  if (unique.length === 0 || index.chunks.length === 0) return [];

  const avgLen =
    index.chunks.reduce((s, c) => s + c.length, 0) / index.chunks.length;
  const k1 = 1.5;
  const b = 0.75;

  const scored = index.chunks.map((c) => {
    let score = 0;
    for (const tok of unique) {
      const tf = c.tf[tok];
      if (!tf) continue;
      const idf = index.idf[tok] ?? 0;
      const norm = 1 - b + b * (c.length / Math.max(avgLen, 1));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * norm));
    }
    return { chunk: c, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export function formatContext(results: QueryResult[]): string {
  return results
    .map(
      (r, i) =>
        `[${i + 1}] ${r.chunk.path}${r.chunk.heading ? ` → ${r.chunk.heading}` : ""}\n${r.chunk.text}`,
    )
    .join("\n\n---\n\n");
}

function walkFiles(root: string, exts: string[]): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".github") continue;
      if (IGNORED_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(abs);
      else if (e.isFile() && exts.some((x) => e.name.endsWith(x))) out.push(abs);
    }
  }
  return out;
}

interface Piece {
  heading?: string;
  text: string;
}

function chunkMarkdown(body: string): Piece[] {
  const lines = body.split("\n");
  const pieces: Piece[] = [];
  let current: Piece = { text: "" };
  let currentLen = 0;
  const flush = () => {
    if (current.text.trim()) pieces.push(current);
    current = { text: "" };
    currentLen = 0;
  };
  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      flush();
      current = { heading: heading[1], text: line + "\n" };
      currentLen = line.length;
      continue;
    }
    current.text += line + "\n";
    currentLen += line.length + 1;
    if (currentLen > CHUNK_TARGET_LEN) flush();
  }
  flush();
  return pieces;
}

export { tokenize };
