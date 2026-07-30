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
