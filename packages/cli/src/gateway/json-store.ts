import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Single-document JSON persistence helpers shared by the gateway's
 * read-modify-write state files (session-store's session.json /
 * meta.json / escalation markers, etc.).
 *
 * Before this module each loader hand-rolled
 * `JSON.parse(fs.readFileSync(...)) as T` with inconsistent
 * corrupt-tolerance (some threw, some returned undefined) and zero
 * shape validation — directly the "never trust file content" gap the
 * review flagged. `readJsonFile` centralises both: a missing,
 * unreadable, unparseable, or shape-invalid file all collapse to
 * `undefined`, so one bad file on disk can never crash the daemon, and
 * every caller validates the parsed value at the boundary.
 *
 * This module is deliberately storage-only: it takes absolute paths and
 * knows nothing about gateway layout, so it stays trivially testable and
 * reusable.
 */

/**
 * Read + parse + validate a single JSON document. Returns `undefined`
 * when the file is missing, unreadable, not valid JSON, or fails
 * `validate`. The `validate` guard is what makes the return type sound:
 * callers get a `T` they can trust, not a blind `as T` cast.
 */
export function readJsonFile<T>(
  file: string,
  validate: (value: unknown) => value is T,
): T | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    // ENOENT or otherwise unreadable — indistinguishable from "absent"
    // to every caller, so collapse to undefined.
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return validate(parsed) ? parsed : undefined;
}

/**
 * Write a JSON document atomically, creating parent directories as needed.
 * Matches the pre-existing on-disk format exactly: 2-space indent, no
 * trailing newline. `mode` (e.g. 0o600 for secrets) is applied to the temp
 * file before it is published, so the document is never briefly world-readable.
 *
 * Atomic because a plain `writeFileSync` truncates the target in place: a
 * process killed mid-write (SIGKILL, power loss, a launchd restart) leaves a
 * half-written document, and `readJsonFile` then collapses it to `undefined` —
 * the state is silently gone rather than loudly broken. Every caller here is
 * daemon state that outlives a single run (session.json, meta.json, escalation
 * markers, run-state.json).
 *
 * Mechanics: write a sibling temp file in the SAME directory (rename is only
 * atomic within one filesystem), fsync it so the bytes are durable before they
 * become reachable, then rename over the target. A reader either sees the whole
 * old document or the whole new one. Mirrors `writeOfferAtomic` in
 * review-approval.ts, which already held this bar.
 */
export function writeJsonFile(
  file: string,
  value: unknown,
  opts: { mode?: number } = {},
): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(value, null, 2);
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`,
  );
  try {
    // "wx" — never clobber a temp name; the pid+random suffix makes a
    // collision a genuine bug rather than something to silently overwrite.
    const fd = fs.openSync(tmp, "wx", opts.mode);
    try {
      fs.writeFileSync(fd, json, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // openSync's mode is subject to umask; re-assert it so a restrictive
    // request (0o600 for secrets) is exact rather than best-effort.
    if (opts.mode !== undefined) fs.chmodSync(tmp, opts.mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    // Leave the target untouched — the previous document is still the truth.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* temp already gone or undeletable — nothing further to do */
    }
    throw err;
  }
}

/** Narrow an unknown to a plain (non-array, non-null) object. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
