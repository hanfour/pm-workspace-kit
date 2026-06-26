import * as fs from "node:fs";
import { isAllowedSlackHost } from "../attachments/download";
import { MAX_AUDIO_BYTES, type SlackFile } from "../attachments/types";

export async function streamSlackFileToTemp(
  file: SlackFile,
  botToken: string,
  destPath: string,
  deps: { fetchImpl?: typeof fetch; maxBytes?: number } = {},
): Promise<{ bytes: number }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const maxBytes = deps.maxBytes ?? MAX_AUDIO_BYTES;
  const url = file.url_private_download ?? file.url_private;
  if (!url) throw new Error("file URL not available");

  const host = new URL(url).hostname;
  if (!isAllowedSlackHost(host)) throw new Error("refusing non-Slack host");

  if ((file.size ?? 0) > maxBytes) throw new Error("audio exceeds size limit");

  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${botToken}` },
    redirect: "error",
  });

  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status})`);
  }

  const out = fs.createWriteStream(destPath);
  let bytes = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    reader = (response.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("audio stream exceeds size limit");
      await new Promise<void>((resolve, reject) =>
        out.write(value, (err) => (err ? reject(err) : resolve())),
      );
    }
    await new Promise<void>((resolve) => out.end(resolve));
    return { bytes };
  } catch (err) {
    // Cancel the response body reader to release the connection.
    if (reader) await reader.cancel().catch(() => {});
    // Wait for the write stream to close before deleting so no async activity leaks.
    await new Promise<void>((resolve) => {
      out.on("close", resolve);
      out.on("error", () => resolve());
      out.destroy();
    });
    try {
      fs.rmSync(destPath, { force: true });
    } catch {
      // noop — best effort cleanup
    }
    throw err;
  }
}
