/**
 * Guards against the gateway relaying host-machine instructions to Slack.
 *
 * The LLM behind free-chat runs on the operator's machine through the Claude
 * Agent SDK with `allowedTools: []`. When it decides a request needs a shell
 * command, the permission guard refuses and the model explains the refusal the
 * only way it knows how — by telling "you" to run `/permissions` or edit
 * `~/.claude/settings.json`. Posted verbatim to Slack that reply is both
 * useless (the reader is not the operator and has no such file) and a small
 * disclosure of the host's internal layout.
 *
 * This is a defence-in-depth net, not the primary fix: a request that needs
 * host tools should be routed to a real handler, never to free-chat.
 */

/**
 * Tokens that only make sense on the machine running the gateway. Any one of
 * them can appear in a legitimate technical answer — this bot serves an
 * engineering team — so a single hit is not enough to redact.
 */
const HOST_ONLY_MARKERS = [
  /~\/\.claude/i,
  /(?:^|\s)\/permissions\b/,
  /allowedTools/i,
  /permission guard/i,
  /settings\.json/i,
  /dangerously-skip-permissions/i,
] as const;

/** How many distinct markers must co-occur before a reply reads as host guidance. */
const REDACT_THRESHOLD = 2;

const REPLACEMENT =
  ":warning: 這則訊息我沒能完成處理 —— gateway 主機端的工具權限限制擋下了必要的操作。\n" +
  "這是主機設定問題，請聯繫 PMK admin 處理；你不需要修改自己的任何設定。";

export interface HostGuidanceResult {
  /** The text safe to post. Unchanged unless `redacted` is true. */
  text: string;
  /** True when the original was replaced because it read as host guidance. */
  redacted: boolean;
  /** Which markers fired — for operator logs, never for the Slack reply. */
  matched: string[];
}

/**
 * Replace a reply that instructs the reader to reconfigure the host with a
 * message that points at the operator instead. Pure; safe on empty input.
 */
export function stripHostOnlyGuidance(text: string): HostGuidanceResult {
  if (!text) return { text, redacted: false, matched: [] };
  const matched = HOST_ONLY_MARKERS.filter((re) => re.test(text)).map((re) => re.source);
  if (matched.length < REDACT_THRESHOLD) {
    return { text, redacted: false, matched: [] };
  }
  return { text: REPLACEMENT, redacted: true, matched };
}
