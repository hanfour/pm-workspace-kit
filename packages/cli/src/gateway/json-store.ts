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
 * Write a JSON document, creating parent directories as needed. Matches
 * the pre-existing on-disk format exactly: 2-space indent, no trailing
 * newline. `mode` (e.g. 0o600 for secrets) is applied on create.
 */
export function writeJsonFile(
  file: string,
  value: unknown,
  opts: { mode?: number } = {},
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const json = JSON.stringify(value, null, 2);
  if (opts.mode !== undefined) {
    fs.writeFileSync(file, json, { mode: opts.mode });
  } else {
    fs.writeFileSync(file, json, "utf8");
  }
}

/** Narrow an unknown to a plain (non-array, non-null) object. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
