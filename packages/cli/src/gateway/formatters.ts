/**
 * Slack message formatting helpers — keep all platform-specific
 * conversions in one place so the rest of the gateway code stays
 * platform-agnostic.
 *
 * Slack mrkdwn rules (different from CommonMark):
 *   - bold:    *bold*    (not **bold**)
 *   - italic:  _italic_  (single underscore)
 *   - code:    `code`    (same)
 *   - link:    <url|text>
 *   - block:   ```...```  (same fenced code block)
 *
 * For now we ship a tiny converter that keeps fenced code blocks intact
 * and rewrites the most common Markdown→mrkdwn deltas. The model's
 * BASE_RULES already discourages emoji + heavy formatting, so the
 * payloads we feed in are mostly prose + bullets + occasional code.
 */

const MAX_SLACK_MSG_LEN = 38_000; // Slack hard cap is 40,000 chars

export function markdownToMrkdwn(s: string): string {
  // Strip pmk's machine-readable case-update fences (defence in depth —
  // the case command also strips them, but if anything routes a raw
  // response straight to Slack we don't want users to see it).
  s = s.replace(/```case-update\n[\s\S]*?```\s*/g, "");

  // Bold: **x** → *x*  (don't touch *x* which is already mrkdwn-bold)
  s = s.replace(/\*\*(\S[^*]*?\S|\S)\*\*/g, "*$1*");

  // Headings: # / ## / ### → bold (Slack doesn't render headings)
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Inline links [text](url) → <url|text>
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  return s.trim();
}

/**
 * Slack messages are capped at 40K characters. Truncate near the cap
 * with an ellipsis line so the user knows they're seeing a partial.
 */
export function truncateForSlack(s: string): string {
  if (s.length <= MAX_SLACK_MSG_LEN) return s;
  return s.slice(0, MAX_SLACK_MSG_LEN) + "\n\n_…(truncated by pmk)_";
}

/**
 * Apply the case-update confirmation lines as a thread reply.
 * Returns the formatted text or null if nothing to post.
 */
export function formatTrackingSummary(summaries: string[]): string | null {
  if (summaries.length === 0) return null;
  return ["_pmk auto-tracked:_", ...summaries.map((s) => `• ${s}`)].join("\n");
}

/**
 * Wrap a presence / status broadcast.
 */
export function formatOfflineNotice(): string {
  return ":sleeping: pmk gateway 暫離（host 機器離線）。等下次上線會回覆訊息。";
}

export function formatBackOnlineNotice(awayMs?: number): string {
  if (awayMs === undefined) {
    return ":wave: pmk gateway 重新上線。";
  }
  const minutes = Math.round(awayMs / 60_000);
  if (minutes < 1) return ":wave: pmk gateway 重新上線。";
  return `:wave: pmk gateway 重新上線（離線約 ${minutes} 分鐘）。`;
}
