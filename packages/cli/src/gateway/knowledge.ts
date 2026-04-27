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
  };
  if (atom.summary) data.summary = atom.summary;
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
  };
}

export function saveAtom(atom: KnowledgeAtom): string {
  // Sanitise on the way in — caller may pass an LLM-influenced scope.
  const safe: KnowledgeAtom = { ...atom, scope: safeScope(atom.scope) };
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
export function loadAtoms(opts: { scope?: string } = {}): KnowledgeAtom[] {
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
  for (const scope of scopes) {
    const dir = scopeDir(scope);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const raw = fs.readFileSync(path.join(dir, f), "utf8");
        const atom = parseAtomMarkdown(raw);
        if (atom) atoms.push(atom);
      } catch {
        /* skip corrupt */
      }
    }
  }
  atoms.sort((a, b) => b.createdAt - a.createdAt);
  return atoms;
}

/**
 * Score atoms against a query — keyword + tag overlap. Cheap and
 * understandable; upgrade to vector retrieval when atom counts pass
 * a few hundred.
 *
 * Scoring (per atom):
 *   - 3 points per query token that appears in question
 *   - 2 points per query token matching a tag
 *   - 1 point per query token in summary
 *   - 1 point per query token in answer
 */
export function searchAtoms(
  query: string,
  opts: { scope?: string; limit?: number } = {},
): KnowledgeAtom[] {
  const limit = opts.limit ?? 3;
  const atoms = loadAtoms({ scope: opts.scope });
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
