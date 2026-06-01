// Guided demo script + transcript types for `pmk demo run` (P5b). The
// five questions are chosen to hit the five AcmeAds seed atoms and to
// demonstrate the escalation boundary (Q5 asks for a function-level
// answer the PKB intentionally doesn't hold).

export interface DemoTurn {
  /** The text actually posted (mention-prefixed for non-DM channels). */
  question: string;
  posted: boolean;
  /** Final answer text, the "(no reply…)" sentinel, or null (dry-run). */
  answer: string | null;
  replyTs: string | null;
}

export interface DemoTranscript {
  channelId: string;
  dryRun: boolean;
  turns: DemoTurn[];
}

export const ACME_ADS_DEMO_SCRIPT: readonly string[] = [
  "AcmeAds 的 AdFormat 跟 placement 有什麼差別？",
  "某個 placement 的 vCPM 怎麼算？資料在哪看？",
  "self-service onboarding 上線後，舊客戶的資料怎麼遷？",
  "PlacementRevenue 跟 AccountPayable 差在哪？財報上看哪個？",
  "customer onboarding 的客戶去重規則寫在哪個 module 的哪個函式？",
];

const PLACEHOLDER_MARK = "hourglass_flowing_sand";
// Gateway mra-ask progress lines render as bracketed tags (see
// gateway/slack/progress.ts), optionally ANSI-wrapped, at the start of
// the updated placeholder text.
const PROGRESS_RE = /^\s*(?:\[[0-9;]*m)?\[(?:ask|pkb|err|case|escalate)\]/i;

/**
 * True when Slack message text is a real final answer — not the
 * `:hourglass…:` placeholder and not an mra-ask progress line. Used in
 * Phase 2 of completion detection, because the gateway emits
 * turn.processed BEFORE its final chat.update (free-chat-turn.ts:302
 * vs :314), so the event firing doesn't mean the final text has landed.
 */
export function isFinalAnswerText(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  if (t.includes(PLACEHOLDER_MARK)) return false;
  if (PROGRESS_RE.test(t)) return false;
  return true;
}
