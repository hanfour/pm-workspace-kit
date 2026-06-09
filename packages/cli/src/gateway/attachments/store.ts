import * as fs from "node:fs";
import * as path from "node:path";
import { attachmentLogPath, assertSafeSegment } from "../session-store";
import type { ExtractedAttachment, ThreadKey } from "./types";

function pathFor(key: ThreadKey): string {
  return key.kind === "dm"
    ? attachmentLogPath("dm", key.userId, key.threadTs)
    : attachmentLogPath("channel", key.channelId, key.threadTs);
}

/** Load all non-empty attachments for a thread (corrupt lines skipped). */
export function loadAttachments(key: ThreadKey): ExtractedAttachment[] {
  const file = pathFor(key);
  if (!fs.existsSync(file)) return [];
  const out: ExtractedAttachment[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const a = JSON.parse(line) as ExtractedAttachment;
      if (a && typeof a.fileId === "string" && typeof a.text === "string" && a.text.length > 0) {
        out.push(a);
      }
    } catch { /* skip corrupt line */ }
  }
  return out;
}

/** True iff a non-empty entry for fileId already exists. */
export function hasAttachment(key: ThreadKey, fileId: string): boolean {
  return loadAttachments(key).some((a) => a.fileId === fileId);
}

/**
 * Append an attachment idempotently. fileId must be path-safe. A no-op if a
 * non-empty entry for the same fileId is already present. Only the five
 * named fields are persisted (never the raw SlackFile / url_private).
 */
export function appendAttachment(key: ThreadKey, att: ExtractedAttachment): void {
  assertSafeSegment(att.fileId, "fileId");
  if (att.text.length > 0 && hasAttachment(key, att.fileId)) return;
  const file = pathFor(key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record: ExtractedAttachment = {
    fileId: att.fileId,
    name: att.name,
    mimetype: att.mimetype,
    text: att.text,
    at: att.at,
  };
  fs.appendFileSync(file, JSON.stringify(record) + "\n");
}
