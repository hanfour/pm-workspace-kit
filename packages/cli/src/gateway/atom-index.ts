/**
 * BM25 / TF-IDF index over knowledge atoms (v0.8.4 / #19).
 *
 * The keyword + tag scoring in `searchAtoms` is fine while the corpus
 * is small, but as it grows past ~50 atoms the rankings drift —
 * partial token matches (`widget` substring matching `widgetcategory`)
 * and CJK bigram noise will surface irrelevant atoms above relevant
 * ones. Atom retrieval that's *worse* than no retrieval is dangerous
 * because the model treats them as ground truth.
 *
 * @pmk/rag already provides BM25-scored TF-IDF, used by `pmk ask`.
 * Reusing it here keeps the stack thin and the ranking quality on
 * par with a serious search system.
 *
 * Pending atoms are excluded at index-build time — they're already
 * invisible to retrieval (`searchAtoms` filters them out), so adding
 * them to the index would just waste space. Approved-only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  type IndexedChunk,
  type RagIndex,
  loadIndex,
  query as ragQuery,
  saveIndex,
  tokenize,
} from "@pmk/rag";
import {
  knowledgeRoot,
  loadAtoms,
  type KnowledgeAtom,
} from "./knowledge";

/**
 * Atom corpus size at which `searchAtoms` switches from keyword to
 * BM25. Default 50 is a heuristic — small enough that hosts hit it
 * after a few weeks of escalate flow, large enough that BM25's IDF
 * has signal to work with. Override via `PMK_ATOM_VECTOR_THRESHOLD`.
 */
export const ATOM_RANKED_THRESHOLD = (() => {
  const raw = process.env.PMK_ATOM_VECTOR_THRESHOLD;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
})();

function indexDir(): string {
  return path.join(knowledgeRoot(), ".index");
}

function indexFileFor(scope: string | undefined): string {
  // "_all" sentinel for cross-scope index. Sanitised separately from
  // safeScope() since the leading underscore would be stripped there.
  const file = scope ? `${scope}.json` : "_all.json";
  return path.join(indexDir(), file);
}

/**
 * Filesystem mtime granularity slack (#83). CI filesystems (ext4/overlayfs)
 * can truncate mtimes to whole seconds, so an atom written in the same coarse
 * tick as `builtAt` may compare as NOT newer and the stale cache would be
 * served. Treat anything within this window of `builtAt` as possibly-newer
 * and rebuild — rebuilds are cheap (small corpus) and the check converges
 * once the newest write is older than the window.
 */
const MTIME_TOLERANCE_MS = 2000;

/**
 * Scan every atom .md file under the given scope (or all scopes when
 * `scope` is undefined): latest mtime + file count. Both feed staleness
 * detection — mtime catches edits/additions, the count catches deletions
 * (removing a file never bumps any surviving file's mtime).
 */
function scanAtomFiles(scope?: string): { newestMtime: number; fileCount: number } {
  const root = knowledgeRoot();
  if (!fs.existsSync(root)) return { newestMtime: 0, fileCount: 0 };
  let newest = 0;
  let count = 0;
  const scopes = scope
    ? [scope]
    : fs.readdirSync(root).filter((d) => {
        try {
          return (
            fs.statSync(path.join(root, d)).isDirectory() &&
            !d.startsWith(".")
          );
        } catch {
          return false;
        }
      });
  for (const s of scopes) {
    const dir = path.join(root, s);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const m = fs.statSync(path.join(dir, f)).mtimeMs;
        if (m > newest) newest = m;
        count += 1;
      } catch {
        /* skip */
      }
    }
  }
  return { newestMtime: newest, fileCount: count };
}

/**
 * Pack each approved atom into a single BM25 chunk. We don't split
 * answers into sub-chunks — atoms are typically a few hundred chars
 * each, so per-atom granularity is the right grain for retrieval.
 */
function buildIndexedChunks(atoms: KnowledgeAtom[]): IndexedChunk[] {
  return atoms
    .filter((a) => a.status === "approved" || a.status === undefined)
    .map((a) => {
      // Combine question + summary + answer + tags so all signals
      // contribute to TF-IDF. The model will see the full atom
      // content via formatAtomsForInjection regardless of which
      // slice triggered the match.
      const text = [
        a.question,
        a.summary ?? "",
        a.tags.join(" "),
        a.answer,
      ]
        .filter(Boolean)
        .join("\n\n");
      const tokens = tokenize(text);
      const tf: Record<string, number> = {};
      for (const t of tokens) tf[t] = (tf[t] ?? 0) + 1;
      return {
        // The chunk id = atom id so we can map QueryResult back to
        // the originating atom in `searchAtomsRanked`.
        id: a.id,
        path: a.id,
        title: a.question,
        heading: undefined,
        text,
        tf,
        length: tokens.length,
      };
    });
}

/**
 * Build a fresh RagIndex over approved atoms (optionally scope-
 * filtered) and persist it to `~/.pmk/knowledge/.index/<scope>.json`.
 * Returns the in-memory index so callers can use it directly without
 * re-loading.
 */
export function buildAtomsIndex(opts: { scope?: string } = {}): RagIndex {
  const atoms = loadAtoms({ scope: opts.scope });
  const chunks = buildIndexedChunks(atoms);

  // IDF across all chunks. Same formula as `@pmk/rag`'s indexDocs
  // (BM25-style smoothing).
  const df: Record<string, number> = {};
  for (const c of chunks) {
    for (const tok of Object.keys(c.tf)) df[tok] = (df[tok] ?? 0) + 1;
  }
  const N = Math.max(chunks.length, 1);
  const idf: Record<string, number> = {};
  for (const [tok, count] of Object.entries(df)) {
    idf[tok] = Math.log((N - count + 0.5) / (count + 0.5) + 1);
  }

  const index: RagIndex = {
    version: 1,
    builtAt: new Date().toISOString(),
    root: knowledgeRoot(),
    chunks,
    idf,
    fileCount: scanAtomFiles(opts.scope).fileCount,
  };
  saveIndex(index, indexFileFor(opts.scope));
  return index;
}

/**
 * Load the on-disk index, rebuild if stale or missing. Staleness (#83):
 *   - any atom file's mtime within MTIME_TOLERANCE_MS of (or newer than)
 *     the cached `builtAt` — tolerance absorbs coarse fs mtime granularity;
 *   - the .md file count changed — catches deletions, which mtime can't;
 *   - the cached index predates `fileCount` (older version) — rebuild once.
 * Returns null when there are no atoms to index — caller falls back to
 * keyword search.
 */
function getOrBuildIndex(scope: string | undefined): RagIndex | null {
  const file = indexFileFor(scope);
  const cached = loadIndex(file);
  const scan = scanAtomFiles(scope);
  if (
    cached &&
    cached.fileCount === scan.fileCount &&
    new Date(cached.builtAt).getTime() - scan.newestMtime > MTIME_TOLERANCE_MS
  ) {
    return cached;
  }
  // Stale or missing — rebuild.
  const fresh = buildAtomsIndex({ scope });
  return fresh.chunks.length > 0 ? fresh : null;
}

/**
 * BM25-ranked search over approved atoms. Maps query results back
 * to the underlying KnowledgeAtom by id. Returns up to `limit`
 * atoms sorted by descending relevance.
 *
 * Falls back to an empty result on any error (caller gracefully
 * degrades to keyword scoring upstream).
 */
export function searchAtomsRanked(
  q: string,
  opts: { scope?: string; limit?: number } = {},
): KnowledgeAtom[] {
  const limit = opts.limit ?? 3;
  const index = getOrBuildIndex(opts.scope);
  if (!index) return [];
  const results = ragQuery(index, q, limit);
  if (results.length === 0) return [];

  // Build atom-by-id lookup for the (small) approved set.
  const atoms = loadAtoms({ scope: opts.scope }).filter(
    (a) => a.status === "approved" || a.status === undefined,
  );
  const byId = new Map(atoms.map((a) => [a.id, a]));
  return results
    .map((r) => byId.get(r.chunk.id))
    .filter((a): a is KnowledgeAtom => a !== undefined);
}

/**
 * Count the approved atoms (used by searchAtoms to decide whether
 * BM25 is worth invoking). Cheaper than building the full index.
 */
export function approvedAtomCount(scope?: string): number {
  return loadAtoms({ scope }).filter(
    (a) => a.status === "approved" || a.status === undefined,
  ).length;
}
