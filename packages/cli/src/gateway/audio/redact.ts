export function redactSecrets(s: string): string {
  return s
    .replace(/sk-proj-[A-Za-z0-9_-]+/g, "[openai-key]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[openai-key]")
    .replace(/xox[bpas]-[A-Za-z0-9-]+/g, "[slack-token]")
    .replace(/https?:\/\/\S+/gi, "[url]");
}
