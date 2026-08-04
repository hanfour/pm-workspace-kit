/**
 * Size-bounded rotation for the gateway's launchd-owned stdout/stderr.
 *
 * `StandardOutPath` / `StandardErrorPath` are opened by launchd and never
 * trimmed, so those files only ever grow. One socket-churn episode wrote
 * 1,204,328 rate-limit warnings into `gateway.err.log` — 151 MB, 96.7% of it a
 * single repeated line. Beyond the disk cost, a file that size is impractical
 * to investigate, which is the opposite of what a log is for.
 *
 * COPY-then-TRUNCATE, never rename. launchd holds the descriptor: a renamed
 * file keeps receiving writes and the live path stays empty forever, so the
 * rotation would silently redirect the log into an archive nobody reads.
 * Truncating under the held descriptor is safe because launchd opens with
 * O_APPEND — every write seeks to the current end, so writes resume at offset
 * 0 rather than leaving a sparse hole (verified empirically before this was
 * written).
 *
 * There is a small race: anything written between the copy and the truncate is
 * lost. That is the standard copytruncate trade and the right one here — the
 * alternative needs the writer to reopen, which we do not control.
 */
import * as fs from "node:fs";

export interface RotateOptions {
  /** Rotate once the file exceeds this. */
  maxBytes: number;
  /** How many archives to retain (`.1` … `.keep`). */
  keep: number;
}

export interface RotateResult {
  rotated: boolean;
  /** Bytes moved into `.1`, when rotation happened. */
  bytesArchived?: number;
  /** Why rotation was skipped, when it failed. Never thrown at the caller. */
  error?: string;
}

/**
 * Rotate `file` when it exceeds `maxBytes`. Best-effort by contract: a log
 * that cannot be rotated must never stop the gateway from starting, so every
 * failure is reported in the result instead of thrown.
 */
export function rotateLogIfLarge(
  file: string,
  opts: RotateOptions,
): RotateResult {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { rotated: false }; // absent — nothing to rotate, not an error
  }
  if (size <= opts.maxBytes) return { rotated: false };

  try {
    // Shift generations from the oldest down, so nothing is overwritten while
    // it is still needed: .2 -> .3, .1 -> .2, and drop whatever falls past keep.
    for (let gen = opts.keep; gen >= 1; gen--) {
      const from = `${file}.${gen}`;
      if (!fs.existsSync(from)) continue;
      if (gen === opts.keep) {
        fs.rmSync(from, { force: true });
      } else {
        fs.renameSync(from, `${file}.${gen + 1}`);
      }
    }
    fs.copyFileSync(file, `${file}.1`);
    fs.truncateSync(file, 0);
    return { rotated: true, bytesArchived: size };
  } catch (err) {
    return { rotated: false, error: (err as Error).message };
  }
}
