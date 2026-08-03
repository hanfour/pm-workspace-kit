/**
 * Pure classifiers for the `:cr:` / `:a:` review-request surface. Each takes the
 * (bot-mention-stripped) message text and decides whether it is a particular
 * kind of review command. Extracted from review.ts to keep the coordinator lean;
 * re-exported from there for back-compat.
 */
import { parsePrRefs } from "../pr-ref";

/** True when a message is a `:cr:` review request with at least one PR link. */
export function isReviewRequest(text: string): boolean {
  return text.includes(":cr:") && parsePrRefs(text).length > 0;
}

/**
 * True when a message is an inline `:a:` approve request: it contains the `:a:`
 * token AND at least one GitHub PR link. `:a:` runs a fast single-agent review
 * then approves iff no high-severity issue is found.
 */
export function isApproveRequest(text: string): boolean {
  return text.includes(":a:") && parsePrRefs(text).length > 0;
}

/**
 * True when a message OPENS with a review command token but carries no PR
 * reference — `:cr:` on its own, `:a: 4914`, and so on.
 *
 * Without this, both typed classifiers return false and the message falls
 * through to free-chat, where the LLM answers a command from its own
 * vocabulary. Live on 2026-08-03 that produced "/code-review 需要指定一個 PR
 * 才能啟動" — `/code-review` is a Claude Code command, not a pmk surface, so the
 * gap leaked internal tooling into a user-facing answer. A classifier that
 * falls through is not silent; it hands the wheel to the model.
 *
 * Anchored at the start on purpose. A message that merely MENTIONS the token
 * ("我剛用 :cr: 審過了") is ordinary chat and belongs in free-chat — answering
 * that with usage help would be its own kind of hijack.
 */
export function isReviewCommandMissingPr(text: string): boolean {
  if (!/^:(cr|a):/.test(text.trim())) return false;
  return parsePrRefs(text).length === 0;
}

/** What to say instead of letting the model improvise. */
export function reviewCommandUsageText(): string {
  return (
    ":information_source: 這個指令需要一個 PR 才能執行。\n" +
    "• `:cr: <PR 連結>` — 執行 code review\n" +
    "• `:a: <PR 連結>` — 先 review，通過後再由 admin 於 thread 回覆 `approve` 授權\n" +
    "例如：`:cr: https://github.com/onead/erp/pull/4914`"
  );
}

/**
 * A GitHub PR link in either bare or Slack (`<url>` / `<url|label>`) form. The
 * confirmation matcher strips these before comparing: the bot asks the admin to
 * reply `approve` in a thread whose root message carries the PR link, so
 * re-sending that link alongside the word is the natural reply. Stripping the
 * link keeps the matcher exact — it never widens what counts as a confirmation,
 * it only ignores the URL.
 */
const PR_LINK_RE =
  /<?https?:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d+(?:\|[^>]*)?>?/g;

/**
 * Bare confirmation inside a review thread. This is intentionally narrower than
 * ordinary chat: `:cr:` may offer approval, but GitHub APPROVE only happens after
 * an explicit user confirmation.
 *
 * A PR link may accompany the confirmation, but it is NOT trusted to select the
 * PR — the thread's offer does that. The caller must reject a link that names a
 * different PR (see `confirmApproveInThread`), so a link can never redirect an
 * approval to somewhere the admin did not review.
 */
export function isApproveConfirmationRequest(text: string): boolean {
  const t = text
    .replace(PR_LINK_RE, " ")
    .trim()
    .toLowerCase()
    .replace(/[。.!！]+$/g, "")
    .replace(/\s+/g, " ");
  return [
    "approve",
    "approve pr",
    "approve this",
    "confirm approve",
    "yes approve",
    "確認 approve",
    "確認approve",
    "請 approve",
    "可以 approve",
    "進行 approve",
    "核准",
  ].includes(t);
}

/**
 * True when a message is a bare retry command (`retry` / `重試`), used inside a
 * review-result thread to re-run that thread's PR review. The bot @-mention is
 * stripped upstream, so we match the trimmed text exactly to avoid intercepting
 * ordinary chat that merely mentions "retry".
 */
export function isRetryRequest(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === "retry" || t === "重試";
}

export function isRerunRequest(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === "rerun" || t === "重跑";
}
