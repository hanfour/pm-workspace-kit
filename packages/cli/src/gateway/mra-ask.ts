/**
 * Parser + stripper for the `mra-ask` directive emitted by the
 * gateway DM model. Mirrors the shape of `case-update` parsing.
 *
 * Block format (one per response, max one repo+question):
 *
 *   ```mra-ask
 *   repo: erp
 *   question: where is the sales_performances scope defined and what does it touch?
 *   ```
 *
 * The model is instructed to emit this when answering would require
 * code-level details the loaded PKB summaries don't cover. pmk runs
 * `mra ask <repo> "<question>"`, then re-calls the LLM with the
 * subprocess output as additional context for synthesis.
 */

export interface MraAskRequest {
  repo: string;
  question: string;
}

const FENCE_RE = /```mra-ask\n([\s\S]*?)```/;

/**
 * Parse the first `mra-ask` fenced block from a response. Returns
 * undefined if the block is absent, malformed, or missing either
 * required field.
 */
export function parseMraAsk(response: string): MraAskRequest | undefined {
  const fence = FENCE_RE.exec(response);
  if (!fence) return undefined;
  const body = fence[1];
  let repo: string | undefined;
  let question: string | undefined;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([a-z-]+)\s*:\s*(.+)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "repo" && repo === undefined) repo = value.trim();
    else if (key === "question" && question === undefined)
      question = value.trim();
  }
  if (!repo || !question) return undefined;
  // `repo` is LLM-generated and gets passed as an argv element to the
  // `mra` subprocess. spawn() takes an array (no shell), so there's no
  // shell-injection risk, but a value like `--foo` or `../x` could be
  // misread as an option or escape the intended repo. Constrain it to a
  // plain repo-name shape and reject leading-dash option lookalikes.
  if (
    repo.startsWith("-") ||
    repo.includes("..") ||
    !/^[a-zA-Z0-9_.\/-]+$/.test(repo)
  ) {
    return undefined;
  }
  return { repo, question };
}

/**
 * Strip the `mra-ask` fenced block from a response so the user-facing
 * Slack message doesn't include the machine-readable directive.
 */
export function stripMraAskBlock(response: string): string {
  return response
    .replace(/\n*```mra-ask\n[\s\S]*?```\s*$/, "")
    .replace(/```mra-ask\n[\s\S]*?```\n*/g, "")
    .trimEnd();
}
