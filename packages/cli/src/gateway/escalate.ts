/**
 * Parser + stripper for the `escalate` directive that the gateway-DM
 * model emits when neither PKB nor mra-ask can answer a question.
 *
 * Block format (one per response):
 *
 *   ```escalate
 *   repo: erp                  # optional — picks an IT pool
 *   question: <restated question>
 *   reason: <why neither PKB nor mra-ask works>
 *   ```
 *
 * pmk uses the parsed block to:
 *   1. @-mention an IT/domain contact in the same Slack thread
 *   2. Mark the thread as "pending escalation" so the next reply from
 *      a registered contributor gets absorbed into the knowledge store
 */

export interface EscalateRequest {
  repo?: string;
  question: string;
  reason?: string;
}

const FENCE_RE = /```escalate\n([\s\S]*?)```/;

/**
 * Restrict the LLM-supplied repo hint to a safe relative path. mra repo
 * ids are legitimately nested (e.g. `erp/order`), so we allow `/`-joined
 * segments of [A-Za-z0-9._-] — but reject traversal, empty segments, and
 * a leading `/`, and drop any other character. Capped at 64 chars.
 */
function safeRepoHint(s: string): string | undefined {
  const cleaned = s
    .replace(/[^a-zA-Z0-9._/-]/g, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .slice(0, 64);
  const segs = cleaned.split("/").filter((seg) => seg.length > 0 && seg !== "." && seg !== "..");
  const safe = segs.join("/");
  return safe || undefined;
}

export function parseEscalate(response: string): EscalateRequest | undefined {
  const fence = FENCE_RE.exec(response);
  if (!fence) return undefined;
  const body = fence[1];
  let repo: string | undefined;
  let question: string | undefined;
  let reason: string | undefined;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([a-z-]+)\s*:\s*(.+)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "repo" && repo === undefined) repo = safeRepoHint(value.trim());
    else if (key === "question" && question === undefined) {
      question = value.trim();
    } else if (key === "reason" && reason === undefined) reason = value.trim();
  }
  if (!question) return undefined;
  return { repo, question, reason };
}

export function stripEscalateBlock(response: string): string {
  return response
    .replace(/\n*```escalate\n[\s\S]*?```\s*$/, "")
    .replace(/```escalate\n[\s\S]*?```\n*/g, "")
    .trimEnd();
}
