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

function scopeDir(scope: string): string {
  return path.join(knowledgeRoot(), scope || "general");
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

function escapeYaml(s: string): string {
  return s.replace(/"/g, '\\"');
}

function renderAtomMarkdown(atom: KnowledgeAtom): string {
  const fm = [
    "---",
    `id: ${atom.id}`,
    `createdAt: ${atom.createdAt}`,
    `scope: ${atom.scope}`,
    `question: "${escapeYaml(atom.question)}"`,
    `tags: [${atom.tags.map((t) => JSON.stringify(t)).join(", ")}]`,
    `source:`,
    `  threadKey: "${escapeYaml(atom.source.threadKey)}"`,
    `  contributorUserId: ${atom.source.contributorUserId}`,
    atom.summary ? `summary: "${escapeYaml(atom.summary)}"` : undefined,
    "---",
  ]
    .filter(Boolean)
    .join("\n");
  return [
    fm,
    "",
    `# ${atom.question}`,
    "",
    "## Answer",
    "",
    atom.answer.trim(),
    atom.summary ? "\n## Summary\n\n" + atom.summary.trim() : "",
    "",
  ].join("\n");
}

/**
 * Tolerant front-matter parser — atoms are LLM-generated so we
 * accept minor format drift. Returns undefined on hard failures.
 */
function parseAtomMarkdown(raw: string): KnowledgeAtom | undefined {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) return undefined;
  const [, frontMatter, body] = m;
  const get = (key: string): string | undefined => {
    const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
    const found = re.exec(frontMatter);
    return found ? found[1].trim().replace(/^"|"$/g, "") : undefined;
  };
  const id = get("id");
  const createdAtStr = get("createdAt");
  const scope = get("scope") ?? "general";
  const question = get("question") ?? "";
  const summary = get("summary");
  const contributorUserId =
    /contributorUserId:\s*(.+)/.exec(frontMatter)?.[1].trim() ?? "";
  const threadKey =
    /threadKey:\s*"?([^"\n]+?)"?\s*$/m.exec(frontMatter)?.[1] ?? "";
  const tagsRaw = /tags:\s*\[([^\]]*)\]/.exec(frontMatter)?.[1] ?? "";
  const tags = tagsRaw
    .split(",")
    .map((t) => t.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  const answerMatch = /## Answer\n+([\s\S]*?)(?:\n## |\n*$)/.exec(body);
  const answer = answerMatch ? answerMatch[1].trim() : body.trim();
  if (!id || !createdAtStr) return undefined;
  return {
    id,
    createdAt: Number.parseInt(createdAtStr, 10),
    scope,
    question,
    answer,
    summary: summary || undefined,
    tags,
    source: { threadKey, contributorUserId },
  };
}

export function saveAtom(atom: KnowledgeAtom): string {
  const dir = scopeDir(atom.scope);
  fs.mkdirSync(dir, { recursive: true });
  const file = atomFile(atom);
  fs.writeFileSync(file, renderAtomMarkdown(atom), "utf8");
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
    ? [opts.scope]
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
 *   - 1 point per query token in summary (or answer if no summary)
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

function tokenize(s: string): string[] {
  // CJK + alphanumeric: split on whitespace + ASCII punctuation; for
  // CJK we also slice into bigrams since users won't space-separate
  // 廣告 / 版型. Cheap, good-enough for keyword retrieval.
  const lower = s.toLowerCase();
  const ascii = lower
    .split(/[\s,.!?;:()\[\]{}<>"'`/\\|=+\-*&^%$#@~]+/u)
    .filter((t) => /[a-z0-9]/.test(t) && t.length >= 2);
  const cjk: string[] = [];
  const cjkRe = /[一-鿿]+/g;
  let m: RegExpExecArray | null;
  while ((m = cjkRe.exec(lower)) !== null) {
    const run = m[0];
    for (let i = 0; i < run.length - 1; i++) cjk.push(run.slice(i, i + 2));
    if (run.length === 1) cjk.push(run);
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
