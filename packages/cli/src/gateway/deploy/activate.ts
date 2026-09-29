import * as fs from "node:fs";
import * as path from "node:path";
import { RELEASE_INFO_FILE, pointLink, readLink, releaseDir, removeLink } from "./paths";

/**
 * ~1 s per poll. The gateway's own drain can take up to 90 s, but launchd's
 * default ExitTimeOut (20 s) kills the old process first, so 60 polls suffice.
 */
export const READY_POLL_MAX = 60;
const POLL_INTERVAL_MS = 1000;

export interface ActivateDeps {
  restart: () => Promise<string>;
  readReady: () => { pid: number; phase: string } | undefined;
  sleep: (ms: number) => Promise<void>;
  /** True when the installed LaunchAgent's entry point is releases/current. */
  serviceRunsCurrent: () => boolean;
}

export type ActivateOutcome = "activated" | "already-current" | "links-only" | "rolled-back" | "failed";

export interface ActivateResult {
  outcome: ActivateOutcome;
  release: string;
  previous?: string;
  message: string;
}

/**
 * Under launchd the restart is `kickstart -k`, which returns at once. Success
 * is a DIFFERENT pid reporting phase "ready": the old process's record is
 * still on disk right after the kick, and "starting" only means it booted.
 */
async function restartAndAwaitReady(d: ActivateDeps): Promise<{ ready: boolean; message: string }> {
  const before = d.readReady()?.pid;
  try {
    await d.restart();
  } catch (error) {
    return { ready: false, message: `restart failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  for (let i = 0; i < READY_POLL_MAX; i++) {
    await d.sleep(POLL_INTERVAL_MS);
    const r = d.readReady();
    if (r && r.pid !== before && r.phase === "ready") return { ready: true, message: "" };
  }
  return { ready: false, message: `did not reach phase "ready" within ${READY_POLL_MAX}s` };
}

function restoreLinks(root: string, current: string, previous: string | undefined): void {
  pointLink(root, "current", current);
  if (previous) pointLink(root, "previous", previous);
  else removeLink(root, "previous");
}

export async function activateRelease(
  a: { root: string; name: string },
  d: ActivateDeps,
): Promise<ActivateResult> {
  if (!fs.existsSync(path.join(releaseDir(a.root, a.name), RELEASE_INFO_FILE))) {
    throw new Error(`release ${a.name} is not built`);
  }
  const oldCurrent = readLink(a.root, "current");
  const oldPrevious = readLink(a.root, "previous");
  if (oldCurrent === a.name) {
    return { outcome: "already-current", release: a.name, message: `${a.name} is already current; not restarted.` };
  }

  if (oldCurrent) pointLink(a.root, "previous", oldCurrent);
  pointLink(a.root, "current", a.name);

  if (!d.serviceRunsCurrent()) {
    return {
      outcome: "links-only",
      release: a.name,
      previous: oldCurrent,
      message:
        `current → ${a.name}. The LaunchAgent does not run releases/current, so the service was NOT restarted.\n` +
        `Migrate once: ${path.join(a.root, "current", "packages", "cli", "dist", "index.js")} gateway install-service --force, then restart.`,
    };
  }

  const attempt = await restartAndAwaitReady(d);
  if (attempt.ready) {
    return { outcome: "activated", release: a.name, previous: oldCurrent, message: `activated ${a.name}.` };
  }
  return recoverRelease(a, d, oldCurrent, oldPrevious, attempt.message);
}

async function recoverRelease(
  a: { root: string; name: string },
  d: ActivateDeps,
  oldCurrent: string | undefined,
  oldPrevious: string | undefined,
  failure: string,
): Promise<ActivateResult> {
  if (!oldCurrent) {
    return {
      outcome: "failed",
      release: a.name,
      message: `${a.name} ${failure}; there is no previous release to roll back to — see ~/.pmk/logs/gateway.err.log`,
    };
  }
  restoreLinks(a.root, oldCurrent, oldPrevious);
  const recovered = await restartAndAwaitReady(d);
  return {
    outcome: recovered.ready ? "rolled-back" : "failed",
    release: a.name,
    previous: oldCurrent,
    message: recovered.ready
      ? `${a.name} ${failure}; rolled back to ${oldCurrent}.`
      : `${a.name} ${failure}; recovery of ${oldCurrent} ${recovered.message} — see ~/.pmk/logs/gateway.err.log`,
  };
}

export async function rollbackRelease(root: string, d: ActivateDeps): Promise<ActivateResult> {
  const previous = readLink(root, "previous");
  if (!previous) throw new Error("no previous release to roll back to");
  return activateRelease({ root, name: previous }, d);
}
