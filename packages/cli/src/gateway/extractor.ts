/**
 * LLM-based knowledge extractor. Takes a Slack thread's IT-contact
 * answer (plus the original user question + escalation reason) and
 * produces a normalised knowledge atom: cleaned question, summary,
 * tags. Used by the auto-absorb flow when an IT contact replies in a
 * thread that pmk has marked as pending-escalation.
 */

import type { LlmProvider } from "../llm";
import { generateAtomId, type KnowledgeAtom } from "./knowledge";

const EXTRACTOR_PROMPT = `You are a knowledge-base curator. You receive a Slack thread snippet:
- The original question someone asked pmk
- pmk's escalation reason (why pmk couldn't answer)
- A reply from a domain expert

Your job: produce a clean, reusable knowledge atom in JSON. Output ONLY the JSON object — no markdown fences, no preamble.

Schema:
{
  "question": "<cleaned-up question, ≤ 120 chars; faithful to original intent>",
  "summary": "<1–2 short sentences summarising the expert answer; this is what retrieval matches against>",
  "tags": ["<3–6 lowercase keyword tags; English or 繁體中文 nouns; pick discoverable terms from the answer>"]
}

Rules:
- The summary must be self-contained — readable without seeing the question.
- Tags should be the kind of words a future user would type when asking the same thing. Include domain terms (e.g. "adformat", "活動狀態", "ability.rb") and key entities.
- No invented detail. If something is uncertain in the answer, don't claim certainty in the summary.
- Output is parsed by JSON.parse; nothing outside the braces.`;

export interface ExtractInput {
  question: string;
  reason?: string;
  expertAnswer: string;
  scope: string;
  threadKey: string;
  contributorUserId: string;
}

/**
 * Run the extractor LLM call and assemble a KnowledgeAtom. Returns
 * undefined if the LLM output can't be parsed (callers should log and
 * skip — better to drop one atom than to corrupt the store).
 */
export async function extractKnowledgeAtom(
  llm: LlmProvider,
  input: ExtractInput,
): Promise<KnowledgeAtom | undefined> {
  const userMessage = [
    `Original question:\n${input.question}`,
    "",
    input.reason ? `Why pmk couldn't answer:\n${input.reason}` : "",
    "",
    `Expert reply (verbatim):\n${input.expertAnswer}`,
  ]
    .filter(Boolean)
    .join("\n");
  const out = await llm.chat(
    EXTRACTOR_PROMPT,
    [{ role: "user", content: userMessage }],
    { onToken: () => {} },
  );
  const json = extractJsonBlob(out);
  if (!json) return undefined;
  let parsed: { question?: unknown; summary?: unknown; tags?: unknown };
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (
    typeof parsed.question !== "string" ||
    typeof parsed.summary !== "string"
  ) {
    return undefined;
  }
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.toLowerCase().trim())
        .filter(Boolean)
        .slice(0, 8)
    : [];
  return {
    id: generateAtomId(parsed.question),
    createdAt: Date.now(),
    scope: input.scope || "general",
    question: parsed.question.trim(),
    answer: input.expertAnswer.trim(),
    summary: parsed.summary.trim(),
    tags,
    source: {
      threadKey: input.threadKey,
      contributorUserId: input.contributorUserId,
    },
  };
}

/**
 * The extractor is told to output bare JSON, but small models sometimes
 * still wrap it in fences or add a prose preamble. Salvage by grabbing
 * the first balanced { ... } region.
 */
function extractJsonBlob(s: string): string | undefined {
  const fenceMatch = /```(?:json)?\n([\s\S]*?)```/.exec(s);
  const candidate = fenceMatch ? fenceMatch[1] : s;
  const start = candidate.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start; i < candidate.length; i++) {
    if (candidate[i] === "{") depth++;
    else if (candidate[i] === "}") {
      depth--;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return undefined;
}
