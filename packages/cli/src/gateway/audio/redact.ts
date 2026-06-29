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
    // phone: require a leading + OR separator-delimited groups, so bare numeric IDs are not hit
    .replace(/\+\d[\d\s-]{7,}\d|\b\d{2,4}[\s-]\d{3,4}[\s-]\d{3,4}\b/g, "[phone]")
    .replace(/https?:\/\/\S+/gi, "[url]");
}

/** Count base64/hex-ish tokens long enough to plausibly be a credential. */
export function countHighEntropyTokens(s: string): number {
  const m = s.match(/\b[A-Za-z0-9+/_=-]{32,}\b/g);
  return m ? m.length : 0;
}
