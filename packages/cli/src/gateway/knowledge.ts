/**
 * Persistent knowledge atoms — IT/domain answers that pmk has absorbed
 * via the escalation flow. Stored on the host machine; not synced to
 * git by default.
 *
 *   ~/.pmk/knowledge/<scope>/<slug>.md     (scope = "general" if none)
 *
 * Each atom is a markdown file with YAML front-matter so the host can
 * read / hand-edit / delete by hand. Retrieval is keyword + tag based
 * (atoms small enough that a fancier index isn't worth the cost yet).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import matter from "gray-matter";

/**
 * TTL hybrid approval state (v0.7.4):
 *   - "pending"  — fresh atom, NOT visible to retrieval; auto-promotes
 *                  to "approved" once `expiresAt` passes, or earlier
 *                  via `pmk gateway atoms approve <id>`.
 *   - "approved" — visible to retrieval; no expiry.
 *
 * Atoms written by older builds (no `status` field) are treated as
 * "approved" on load so the v0.7.0–v0.7.3 corpus keeps working.
 */
export type KnowledgeAtomStatus = "pending" | "approved";

/** How long a fresh atom sits in pending before auto-promoting. */
export const ATOM_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export interface KnowledgeAtom {
  id: string;
  createdAt: number;
  /** Repo / domain hint; "general" when no scope was specified. */
  scope: string;
  /** Cleaned-up version of the original user question. */
  question: string;
  /** Verbatim text of the IT contact's answer. */
  answer: string;
  /** LLM-extracted 1–2 sentence summary (used for retrieval scoring). */
  summary?: string;
  /** Free-form tags emitted by the extractor (lowercase). */
  tags: string[];
  source: {
    /** "<channelId>:<threadTs>" */
    threadKey: string;
    /** Slack user ID of whoever supplied the answer. */
    contributorUserId: string;
  };
  /**
   * Approval state — see {@link KnowledgeAtomStatus}. Optional at the
   * type level so test fixtures + back-compat callers don't need
   * boilerplate; saveAtom defaults a missing value to "approved".
   * The extractor always sets "pending" explicitly, so production
   * absorb-flow atoms are never accidentally approved-on-creation.
   */
  status?: KnowledgeAtomStatus;
  /** Epoch ms when a pending atom auto-promotes; absent on approved. */
  expiresAt?: number;
  /**
   * Slack message anchor for v0.8.5 reaction-based approval (#21).
   * Captures the ts of the bot's "暫存為 pending..." confirmation post
   * so reactions on that message can be mapped back to this atom.
   * Absent on atoms saved before v0.8.5 or written without going
   * through the Slack absorb path.
   */
  approval?: {
    channelId: string;
    messageTs: string;
  };
}

export function knowledgeRoot(): string {
  return path.join(os.homedir(), ".pmk", "knowledge");
}

/**
 * Sanitise an LLM-supplied scope name down to a single safe path
 * segment. The model emits `repo: <X>` in escalate blocks; without
 * this guard a prompt-injected `repo: ../../tmp/foo` would let the
 * atom file land outside the knowledge root.
 *
 * Allowed characters: ASCII letters, digits, dash, underscore.
 * Dots stripped entirely (closes both `.` / `..` traversal and
 * dotted-segment confusion). Capped at 64 chars. Falls back to
 * "general" when nothing valid survives.
 */
export function safeScope(scope: string | undefined): string {
  if (!scope) return "general";
  const cleaned = scope
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || "general";
}

function scopeDir(scope: string): string {
  return path.join(knowledgeRoot(), safeScope(scope));
}

function atomFile(atom: Pick<KnowledgeAtom, "id" | "scope">): string {
  return path.join(scopeDir(atom.scope), `${atom.id}.md`);
}

/**
 * Build a stable, filesystem-safe slug from an atom's question. Used
 * as the file basename so a directory listing is human-readable.
 */
export function slugifyQuestion(question: string, maxLen = 60): string {
  const cleaned = question
    .toLowerCase()
    .replace(/[`*_~#>[\]()]/g, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.slice(0, maxLen) || "atom";
}

/**
 * Generate a fresh atom id. Includes a short timestamp so atoms sort
 * chronologically when listed; suffixes a random hex to avoid collisions
 * within the same second.
 */
export function generateAtomId(question: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const suffix = Math.random().toString(16).slice(2, 6);
  return `${stamp}-${suffix}-${slugifyQuestion(question, 30)}`;
}

interface AtomFrontMatter {
  id: string;
  createdAt: number;
  scope: string;
  question: string;
  summary?: string;
  tags: string[];
  source: { threadKey: string; contributorUserId: string };
  status?: KnowledgeAtomStatus;
  expiresAt?: number;
  approval?: { channelId: string; messageTs: string };
}

function renderAtomMarkdown(atom: KnowledgeAtom): string {
  // gray-matter handles all the YAML escaping (newlines, quotes,
  // backslashes) — much safer than the hand-rolled emitter that came
  // before. Body holds the full answer; front-matter holds the
  // structured fields used by retrieval.
  const data: AtomFrontMatter = {
    id: atom.id,
    createdAt: atom.createdAt,
    scope: atom.scope,
    question: atom.question,
    tags: atom.tags,
    source: atom.source,
    status: atom.status,
  };
  if (atom.summary) data.summary = atom.summary;
  if (atom.expiresAt !== undefined) data.expiresAt = atom.expiresAt;
  if (atom.approval) data.approval = atom.approval;
  const body = [
    `# ${atom.question}`,
    "",
    "## Answer",
    "",
    atom.answer.trim(),
    atom.summary ? "\n## Summary\n\n" + atom.summary.trim() : "",
    "",
  ].join("\n");
  return matter.stringify(body, data as unknown as Record<string, unknown>);
}

function parseAtomMarkdown(raw: string): KnowledgeAtom | undefined {
  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(raw);
  } catch {
    return undefined;
  }
  const data = parsed.data as Partial<AtomFrontMatter> & {
    source?: { threadKey?: string; contributorUserId?: string };
  };
  if (
    typeof data.id !== "string" ||
    typeof data.createdAt !== "number" ||
    typeof data.question !== "string"
  ) {
    return undefined;
  }
  // Body holds "## Answer\n\n<answer>\n[## Summary...]"; we recover
  // the answer from the first H2 (or fall back to the whole body
  // when the structure drifted).
  const answerMatch = /## Answer\n+([\s\S]*?)(?:\n## |\n*$)/.exec(
    parsed.content,
  );
  const answer = answerMatch ? answerMatch[1].trim() : parsed.content.trim();
  // Back-compat: atoms written before v0.7.4 have no `status` field —
  // they were already in the store, so treat them as approved.
  const status: KnowledgeAtomStatus =
    data.status === "pending" ? "pending" : "approved";
  return {
    id: data.id,
    createdAt: data.createdAt,
    scope: safeScope(data.scope),
    question: data.question,
    answer,
    summary: data.summary,
    tags: Array.isArray(data.tags)
      ? data.tags.filter((t): t is string => typeof t === "string")
      : [],
    source: {
      threadKey: data.source?.threadKey ?? "",
      contributorUserId: data.source?.contributorUserId ?? "",
    },
    status,
    expiresAt: typeof data.expiresAt === "number" ? data.expiresAt : undefined,
    approval:
      data.approval &&
      typeof data.approval.channelId === "string" &&
      typeof data.approval.messageTs === "string"
        ? {
            channelId: data.approval.channelId,
            messageTs: data.approval.messageTs,
          }
        : undefined,
  };
}

export function saveAtom(atom: KnowledgeAtom): string {
  // Sanitise on the way in — caller may pass an LLM-influenced scope.
  // Default status to "approved" when caller didn't specify; production
  // absorb-flow always sets "pending" explicitly via the extractor.
  const safe: KnowledgeAtom = {
    ...atom,
    scope: safeScope(atom.scope),
    status: atom.status ?? "approved",
  };
  const dir = scopeDir(safe.scope);
  fs.mkdirSync(dir, { recursive: true });
  const file = atomFile(safe);
  fs.writeFileSync(file, renderAtomMarkdown(safe), "utf8");
  return file;
}

/**
 * Load every atom under `~/.pmk/knowledge/`. Returns sorted by
 * createdAt descending. Optionally filter by scope.
 */
export function loadAtoms(
  opts: {
    scope?: string;
    /**
     * When true (default), TTL-expired pending atoms are auto-promoted
     * AND the file is rewritten to disk. Set to false for read-only
     * callers (e.g. `pmk gateway audit`) that should not have a write
     * side-effect just from reading the corpus. With promote=false the
     * in-memory atom keeps its original `status` / `expiresAt`, so the
     * audit reflects the true on-disk state at observation time.
     */
    promote?: boolean;
  } = {},
): KnowledgeAtom[] {
  const promote = opts.promote ?? true;
  const root = knowledgeRoot();
  if (!fs.existsSync(root)) return [];
  const atoms: KnowledgeAtom[] = [];
  const scopes = opts.scope
    ? [safeScope(opts.scope)]
    : fs.readdirSync(root).filter((d) => {
        try {
          return fs.statSync(path.join(root, d)).isDirectory();
        } catch {
          return false;
        }
      });
  const now = Date.now();
  for (const scope of scopes) {
    const dir = scopeDir(scope);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const raw = fs.readFileSync(path.join(dir, f), "utf8");
        const atom = parseAtomMarkdown(raw);
        if (!atom) continue;
        // Auto-promote pending atoms whose TTL has passed. Rewrite to
        // disk so the side-effect is persistent (next load is a no-op).
        if (
          promote &&
          atom.status === "pending" &&
          atom.expiresAt !== undefined &&
          atom.expiresAt <= now
        ) {
          atom.status = "approved";
          atom.expiresAt = undefined;
          try {
            fs.writeFileSync(
              path.join(dir, f),
              renderAtomMarkdown(atom),
              "utf8",
            );
          } catch {
            /* best-effort; if rewrite fails, in-memory promotion still
               applies for this load() call. */
          }
        }
        atoms.push(atom);
      } catch {
        /* skip corrupt */
      }
    }
  }
  atoms.sort((a, b) => b.createdAt - a.createdAt);
  return atoms;
}

/**
 * Approve a pending atom by id (or unique id-prefix). Returns the
 * promoted atom on success, undefined if no match / multiple matches.
 * If already approved, returns the existing atom unchanged.
 */
export function approveAtom(idOrPrefix: string): KnowledgeAtom | undefined {
  const found = findAtomByPrefix(idOrPrefix);
  if (!found) return undefined;
  if (found.atom.status === "approved") return found.atom;
  found.atom.status = "approved";
  found.atom.expiresAt = undefined;
  fs.writeFileSync(found.file, renderAtomMarkdown(found.atom), "utf8");
  return found.atom;
}

/**
 * Reject a pending or approved atom by id (or unique id-prefix).
 * Deletes the file. Returns true on success, false when no match /
 * multiple matches.
 */
export function rejectAtom(idOrPrefix: string): boolean {
  const found = findAtomByPrefix(idOrPrefix);
  if (!found) return false;
  fs.unlinkSync(found.file);
  return true;
}

interface AtomLocation {
  atom: KnowledgeAtom;
  file: string;
}

/**
 * Resolve an atom by full id or unique prefix. Used by the CLI so the
 * host doesn't have to type the full timestamp-suffixed id.
 *
 * Multi-match returns undefined — caller should ask the user to add
 * more chars.
 */
export function findAtomByPrefix(idOrPrefix: string): AtomLocation | undefined {
  const root = knowledgeRoot();
  if (!fs.existsSync(root)) return undefined;
  const matches: AtomLocation[] = [];
  for (const scope of fs.readdirSync(root)) {
    const dir = scopeDir(scope);
    if (!fs.existsSync(dir)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const id = f.replace(/\.md$/, "");
      if (id !== idOrPrefix && !id.startsWith(idOrPrefix)) continue;
      try {
        const raw = fs.readFileSync(path.join(dir, f), "utf8");
        const atom = parseAtomMarkdown(raw);
        if (atom) matches.push({ atom, file: path.join(dir, f) });
      } catch {
        /* skip */
      }
    }
  }
  if (matches.length !== 1) return undefined;
  return matches[0];
}

/**
 * v0.8.5 (#21): find an atom by the Slack message ts of its bot
 * confirmation post (the ":hourglass_flowing_sand: 暫存為 pending"
 * message). Used by the reaction-approval handler to map a ✅/❌
 * reaction back to the originating atom.
 *
 * Returns undefined when no atom has that anchor — atoms saved
 * before v0.8.5 won't have an `approval` field.
 */
export function findAtomByApprovalMessage(
  channelId: string,
  messageTs: string,
): AtomLocation | undefined {
  const root = knowledgeRoot();
  if (!fs.existsSync(root)) return undefined;
  for (const scope of fs.readdirSync(root)) {
    const dir = scopeDir(scope);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const raw = fs.readFileSync(path.join(dir, f), "utf8");
        const atom = parseAtomMarkdown(raw);
        if (
          atom?.approval?.channelId === channelId &&
          atom.approval.messageTs === messageTs
        ) {
          return { atom, file: path.join(dir, f) };
        }
      } catch {
        /* skip */
      }
    }
  }
  return undefined;
}

/**
 * Score atoms against a query.
 *
 * Two paths, picked at runtime by corpus size:
 *
 *   - **Keyword + tag overlap** (default, used when corpus is small):
 *     cheap and understandable; 3 pts question, 2 pts tag, 1 pt
 *     summary, 1 pt answer. Works fine until ranking quality starts
 *     to matter.
 *   - **BM25 / TF-IDF** (when approved-atom count >= ATOM_RANKED_THRESHOLD,
 *     v0.8.4): delegates to `@pmk/rag`'s query() with a per-scope
 *     index cached at `~/.pmk/knowledge/.index/<scope>.json`.
 *     Auto-rebuilds when the index is stale (any atom file mtime
 *     newer than index builtAt) or missing.
 *
 * Pending atoms are filtered out either way — that's the v0.7.4 TTL
 * gate's whole point. They become visible only after auto-promote or
 * manual approval.
 */
export function searchAtoms(
  query: string,
  opts: { scope?: string; limit?: number } = {},
): KnowledgeAtom[] {
  const limit = opts.limit ?? 3;

  // BM25 fast-path when corpus is large enough to need real ranking.
  // Imported lazily to avoid pulling @pmk/rag into the keyword path's
  // hot loop (and to keep this file's startup cost low).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { approvedAtomCount, ATOM_RANKED_THRESHOLD, searchAtomsRanked } =
    require("./atom-index") as typeof import("./atom-index");
  if (approvedAtomCount(opts.scope) >= ATOM_RANKED_THRESHOLD) {
    const ranked = searchAtomsRanked(query, opts);
    if (ranked.length > 0) return ranked;
    // BM25 yielded nothing — fall through to keyword as a safety net
    // for queries the index can't handle (single-token CJK, etc).
  }

  // Pending atoms are deliberately invisible to retrieval — that's the
  // whole point of the TTL gate. They become visible after auto-promote
  // (loadAtoms rewrites them) or after manual approval.
  const atoms = loadAtoms({ scope: opts.scope }).filter(
    (a) => a.status === "approved",
  );
  if (atoms.length === 0) return [];
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const scored: Array<{ atom: KnowledgeAtom; score: number }> = [];
  for (const atom of atoms) {
    const qTokens = new Set(tokenize(atom.question));
    const summaryTokens = new Set(atom.summary ? tokenize(atom.summary) : []);
    const answerTokens = new Set(tokenize(atom.answer));
    const tagSet = new Set(atom.tags.map((t) => t.toLowerCase()));
    let score = 0;
    for (const t of tokens) {
      if (qTokens.has(t)) score += 3;
      if (tagSet.has(t)) score += 2;
      if (summaryTokens.has(t)) score += 1;
      if (answerTokens.has(t)) score += 1;
    }
    if (score > 0) scored.push({ atom, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.atom);
}

/**
 * Tokenise for keyword search. Covers:
 *   - ASCII alphanumeric (split on whitespace + ASCII punctuation)
 *   - CJK Unified Ideographs incl. Extension A (㐀-鿿) and
 *     Extension B SMP (\u{20000}-\u{2A6DF}) via bigram slicing
 *   - Hiragana / Katakana (぀-ヿ) — Japanese terms in domain
 */
function tokenize(s: string): string[] {
  const lower = s.toLowerCase();
  const ascii = lower
    .split(/[\s,.!?;:()\[\]{}<>"'`/\\|=+\-*&^%$#@~]+/u)
    .filter((t) => /[a-z0-9]/.test(t) && t.length >= 2);
  const cjk: string[] = [];
  const cjkRe = /[぀-ヿ㐀-鿿\u{20000}-\u{2A6DF}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = cjkRe.exec(lower)) !== null) {
    const run = m[0];
    if (run.length === 1) {
      cjk.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) cjk.push(run.slice(i, i + 2));
  }
  return [...new Set([...ascii, ...cjk])];
}

/**
 * Format a list of atoms as a single context block to inject into a
 * gateway-DM session before the user's question. The block reads as
 * a "previous IT clarifications" preface so the model treats it as
 * ground truth, not as something it itself said.
 */
export function formatAtomsForInjection(atoms: KnowledgeAtom[]): string {
  if (atoms.length === 0) return "";
  const blocks = atoms.map((atom, i) => {
    const summaryLine = atom.summary ? `\nSummary: ${atom.summary}` : "";
    return [
      `### [${i + 1}] ${atom.question}`,
      `Scope: ${atom.scope}; contributor: <@${atom.source.contributorUserId}>`,
      summaryLine,
      "",
      atom.answer.trim(),
    ].join("\n");
  });
  return [
    "以下是過去 IT/domain 同事針對類似問題的補充紀錄（請當作 ground truth；如有衝突，以這些紀錄優先於 PKB 的猜測）：",
    "",
    blocks.join("\n\n---\n\n"),
  ].join("\n");
}
