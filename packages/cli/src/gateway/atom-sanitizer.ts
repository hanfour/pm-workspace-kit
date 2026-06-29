/**
 * Heuristic scan for prompt-injection in text destined to become a knowledge
 * atom (which is later injected as retrieval context). Flags + reports; does
 * NOT block — the human 📚/approval gate is the backstop. An LLM-based
 * sanitizer is the deferred escalation if these heuristics prove insufficient.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)/i,
  /disregard\s+(the\s+)?(previous|prior|above|instructions?)/i,
  /system\s+prompt/i,
  /you\s+are\s+now\b/i,
  /\bact\s+as\b/i,
  /always\s+(recommend|say|reply|respond|answer)/i,
  /忽略(前面|以上|先前|上述)/,
  /你現在是/,
  /必須(永遠|一律)/,
];

export function scanForInjection(text: string): { flagged: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const re of INJECTION_PATTERNS) {
    const m = text.match(re);
    if (m) reasons.push(m[0]);
  }
  return { flagged: reasons.length > 0, reasons };
}
