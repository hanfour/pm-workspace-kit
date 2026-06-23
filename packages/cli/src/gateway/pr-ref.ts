/**
 * Parse GitHub PR references out of a Slack message's `text`. Slack renders
 * links as `<url|label>` (or bare `<url>`); we scan for github.com PR URLs in
 * either form. Pure + unit-testable; the ReviewCoordinator feeds it the reacted
 * message text. Deduped by `owner/repo#number`, order-preserving, capped.
 */
export interface PrRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

const DEFAULT_CAP = 5;
// owner/repo: GitHub allows [A-Za-z0-9._-]; require /pull/<digits>.
const PR_URL_RE =
  /https?:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)/g;

export function parsePrRefs(text: string, opts: { cap?: number } = {}): PrRef[] {
  const cap = opts.cap ?? DEFAULT_CAP;
  const out: PrRef[] = [];
  const seen = new Set<string>();
  if (!text) return out;
  for (const m of text.matchAll(PR_URL_RE)) {
    const [, owner, repo, num] = m;
    const number = Number(num);
    if (!Number.isInteger(number) || number <= 0) continue;
    const key = `${owner}/${repo}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      owner,
      repo,
      number,
      url: `https://github.com/${owner}/${repo}/pull/${number}`,
    });
    if (out.length >= cap) break;
  }
  return out;
}
