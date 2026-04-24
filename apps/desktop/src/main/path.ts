import * as os from "node:os";
import * as path from "node:path";

/**
 * Electron apps launched from Launchd (Finder double-click, DMG) get
 * a skeletal PATH — `/usr/bin:/bin:/usr/sbin:/sbin` on macOS — which
 * typically omits user-local bin dirs (`~/.local/bin`, Homebrew, etc.)
 * where Claude Code installs its `claude` binary. This matters for
 * pmk because `resolveProvider()` shells out to `which claude`.
 *
 * Prepend the well-known user bin dirs so `which` (and any other
 * child process we spawn) can find them. Idempotent — re-running is
 * safe even if PATH already has them.
 */
export function augmentUserBinPath(): void {
  const extras: string[] = [];

  if (process.platform === "darwin" || process.platform === "linux") {
    const home = os.homedir();
    extras.push(
      path.join(home, ".local", "bin"),
      path.join(home, ".claude", "local"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    );
  } else if (process.platform === "win32") {
    const home = process.env.USERPROFILE ?? os.homedir();
    extras.push(
      path.join(home, ".claude", "bin"),
      path.join(home, "scoop", "shims"),
    );
  }

  const sep = process.platform === "win32" ? ";" : ":";
  const existing = (process.env.PATH ?? "").split(sep).filter(Boolean);
  const existingSet = new Set(existing);
  const missing = extras.filter((p) => !existingSet.has(p));
  if (missing.length === 0) return;
  process.env.PATH = [...missing, ...existing].join(sep);
}
