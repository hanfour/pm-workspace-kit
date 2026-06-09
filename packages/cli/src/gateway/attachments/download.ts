import { MAX_FILE_BYTES, type SlackFile } from "./types";

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

/** True iff the host is files.slack.com or a *.slack.com subdomain. */
export function isAllowedSlackHost(hostname: string): boolean {
  return hostname === "files.slack.com" || hostname.endsWith(".slack.com");
}

/**
 * Download a Slack file's bytes with the bot token. Security:
 *  - host allowlist BEFORE fetch (no SSRF to internal hosts);
 *  - redirect:"error" (an allowlisted URL can't 30x to an internal host);
 *  - hard byte cap during streaming (file.size metadata is untrusted).
 * Never throws a URL/token-bearing error.
 */
export async function fetchSlackFile(
  file: SlackFile,
  botToken: string,
  deps: { fetchImpl?: FetchImpl } = {},
): Promise<Buffer> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchImpl);
  const url = file.url_private_download ?? file.url_private;
  if (!url) throw new Error(`download failed for ${file.id} (no url)`);

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`download failed for ${file.id} (bad url)`);
  }

  // SSRF guard: allowlist check BEFORE any network call
  if (!isAllowedSlackHost(host)) {
    throw new Error(`download failed for ${file.id} (unexpected file host)`);
  }

  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${botToken}` },
      redirect: "error",
    });
  } catch {
    throw new Error(`download failed for ${file.id} (network error)`);
  }

  if (res.status === 403) {
    throw new Error(
      `download failed for ${file.id} — the Slack app needs the files:read scope (update + reinstall).`,
    );
  }
  if (!res.ok || !res.body) {
    throw new Error(`download failed for ${file.id} (http ${res.status})`);
  }

  // Hard byte cap enforced DURING streaming — file.size is attacker-controlled metadata
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FILE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error(`download failed for ${file.id} (exceeds size limit)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}
