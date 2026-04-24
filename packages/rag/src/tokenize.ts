/**
 * Whitespace + CJK-aware tokeniser. Lowercases ASCII, keeps CJK chars
 * as individual tokens (character-level), drops everything else.
 *
 * Good enough for PM-doc retrieval; not good enough for Chinese-only
 * content where bigrams would beat unigrams.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      tokens.push(buf.toLowerCase());
      buf = "";
    }
  };
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isCjk =
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x309f) ||
      (code >= 0x30a0 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af);
    if (isCjk) {
      flush();
      tokens.push(ch);
    } else if (/[a-zA-Z0-9_\-]/.test(ch)) {
      buf += ch;
    } else {
      flush();
    }
  }
  flush();
  return tokens;
}
