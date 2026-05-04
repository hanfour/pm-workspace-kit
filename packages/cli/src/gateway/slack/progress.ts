/**
 * Sanitize a single mra-ask progress line before drip-feeding it to a
 * Slack placeholder via web.chat.update.
 *
 * Two layers of stripping:
 *   1. ANSI SGR escape sequences (`\x1b[...m`) — mra colorizes its
 *      bracketed tags (`[ask]`, `[pkb]`, `[err]` …). The Slack web
 *      client renders these as literal `[1;37m[ask][0m` text, which is
 *      strictly worse UX than the static spinner that v0.10 replaces.
 *   2. Slack mrkdwn meta-characters — backtick / asterisk / underscore
 *      / angle-bracket. Without this, a chatty progress line could
 *      surface as bold / italic / link / code, or accidentally render
 *      as a `<@U123>` mention or `<https://...|alt>` link.
 *
 * Result is sliced to `maxLen` so a runaway long line cannot blow up
 * the Slack message budget. 200 is plenty for a status tick.
 */
const ANSI_SGR = /\x1b\[[0-9;]*m/g;
const MRKDWN_META = /[`*_<>]/g;

export function sanitizeProgressLine(line: string, maxLen = 200): string {
  return line.replace(ANSI_SGR, "").replace(MRKDWN_META, "").slice(0, maxLen);
}
