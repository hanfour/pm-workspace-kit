import { beforeEach, afterEach } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Point `~` at a throwaway directory for the enclosing describe block.
 *
 * Everything the gateway persists — the event log, claims, atoms, sessions,
 * config — resolves through `os.homedir()`. A test that exercises real
 * production objects without this writes into the OPERATOR'S store.
 *
 * That is not hypothetical: `socket-watchdog-alert.test.ts` constructed a real
 * PresenceBroadcaster and called `watchdogTerminate`, which appends
 * `gateway.offline reason=watchdog-unhealthy` — the daemon's self-termination
 * record. Every suite run wrote three of them to the live audit log. By
 * 2026-08-03 there were 1,056 such entries against ONE genuine incident, so
 * the log said the gateway had self-terminated a thousand times when it had
 * done so once. An audit trail that reports imaginary incidents is worse than
 * one that reports none: it buries the real event and it burns an
 * investigation to find that out.
 *
 * Use this in any test that touches production objects rather than pure
 * functions. Where the write path is injectable, prefer injecting a fake —
 * this is the fallback for objects that reach the filesystem directly.
 */
export function useIsolatedHome(prefix = "pmk-test-home-"): { dir: () => string } {
  const original = process.env.HOME;
  let tmp = "";
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    process.env.HOME = tmp;
  });
  afterEach(() => {
    if (original !== undefined) process.env.HOME = original;
    else delete process.env.HOME;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });
  return { dir: () => tmp };
}
