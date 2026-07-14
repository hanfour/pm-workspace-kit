export function redactSecrets(s: string): string {
  return s
    .replace(/sk-proj-[A-Za-z0-9_-]+/g, "[openai-key]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[openai-key]")
    .replace(/xox[bpas]-[A-Za-z0-9-]+/g, "[slack-token]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[aws-key]")
    .replace(/gh[opsru]_[A-Za-z0-9]{20,}/g, "[github-token]")
    .replace(/glpat-[A-Za-z0-9_-]{20,}/g, "[gitlab-token]")
    .replace(/AIza[0-9A-Za-z_-]{35}/g, "[google-key]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    // phone: an international +-prefixed number, OR a domestic number whose first
    // group is a trunk-prefixed (leading 0) / parenthesised area code. Requiring
    // the 0/() shape stops bare 3-group numeric IDs — order numbers, amounts,
    // ticket refs like "1234 5678 9012" — from being mistaken for phones.
    .replace(/\+\d[\d\s-]{7,}\d|(?<![\d-])\(?0\d{1,3}\)?[\s-]\d{3,4}[\s-]\d{3,4}\b/g, "[phone]")
    .replace(/https?:\/\/\S+/gi, "[url]");
}

/**
 * Count base64/hex-ish tokens long enough to plausibly be a credential.
 * The run of base64 chars is bounded by lookarounds (not \b, which can never
 * terminate on `=`/`+`/`/`) and trailing `=` padding is consumed explicitly, so
 * a padded base64 secret is recognised as one token instead of being split or
 * having its padding silently dropped by the word boundary.
 */
export function countHighEntropyTokens(s: string): number {
  const m = s.match(/(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/=_-])/g);
  return m ? m.length : 0;
}
