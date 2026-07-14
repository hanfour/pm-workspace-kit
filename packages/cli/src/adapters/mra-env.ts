/**
 * Shared secret-stripping for mra subprocess environments. Every mra spawn
 * (ask, review, analyze, capability probe) runs with a scrubbed env so an
 * injected review/ask prompt can't exfiltrate host secrets. Extracted from
 * mra.ts so both the adapter and the review-protocol module can reach it.
 */

/**
 * Secret-shaped env var names. Any key matching this is stripped from an mra
 * subprocess env so an injected review/ask prompt can't exfiltrate it. Broad by
 * design — mirrors the audio ffmpeg/ffprobe strip (gateway/audio/spawn.ts) so
 * the two paths can't drift — and crucially catches the documented `PMK_SLACK_*`
 * production token path that an explicit name list previously missed. mra still
 * authenticates: its `claude` CLI uses its own keychain/OAuth (not the env key),
 * which is why the review path already runs stripped in production.
 */
const SECRET_ENV_RE = /(_TOKEN|_KEY|_SECRET|PASSWORD|APIKEY|ANTHROPIC|OPENAI|SLACK|GITHUB|PMK_)/i;

/** A clone of `process.env` with every secret-shaped var removed. */
export function strippedChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (SECRET_ENV_RE.test(k)) continue;
    env[k] = v;
  }
  return env;
}
