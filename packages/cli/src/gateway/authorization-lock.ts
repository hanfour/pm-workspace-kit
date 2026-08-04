/**
 * The single cross-process authorization lock shared by gateway-config
 * writers and the GitHub-approve POST path (#90 — the #70 release-veto
 * precondition).
 *
 * Why it exists: `ApproveFlow.publishReservation` re-validates live policy with
 * a three-phase revision fence before POSTing, but fences are reads — they
 * cannot exclude a writer landing between the last read and the POST. This
 * lock makes them mutually exclusive: while the approve critical section
 * holds it, `saveGatewayConfig` blocks (bounded), so every config write is
 * serialized either wholly before the section's policy reads (the fences
 * then reject) or wholly after the POST completes.
 *
 * Mechanics: an mkdir-based lock (atomic on POSIX) at
 * `~/.pmk/gateway/authorization.lock/`, same family as the approval-offer
 * lock. The owner file records `{ pid, acquiredAt }`; takeover happens when
 * the owner pid is dead or the hold exceeds `staleMs` (the approve section
 * spans several GitHub calls, so holds are seconds — a stale hold means a
 * crashed/hung holder). Takeover is an atomic RENAME to a tombstone, never
 * an rm of the live path, so two contenders cannot delete each other's
 * freshly acquired lock.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { gatewayDir } from "./config";

export class AuthorizationLockBusyError extends Error {
  constructor(heldByPid?: number) {
    super(
      `authorization lock is busy${heldByPid ? ` (held by pid ${heldByPid})` : ""} — ` +
        "a GitHub approve may be in flight; retry shortly",
    );
    this.name = "AuthorizationLockBusyError";
  }
}

export interface AuthorizationLockOptions {
  /** Give up acquiring after this long. Default 15s. */
  acquireTimeoutMs?: number;
  /** A hold older than this is presumed crashed/hung and taken over. Default 120s. */
  staleMs?: number;
  /** Retry cadence while waiting. Default 50ms. */
  pollMs?: number;
}

const DEFAULTS = { acquireTimeoutMs: 15_000, staleMs: 120_000, pollMs: 50 };

export function authorizationLockPath(): string {
  return path.join(gatewayDir(), "authorization.lock");
}

interface Owner {
  pid: number;
  acquiredAt: number;
}

function readOwner(lock: string): Owner | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(lock, "owner"), "utf8")) as Owner;
    if (typeof raw.pid === "number" && typeof raw.acquiredAt === "number") return raw;
  } catch {
    /* unreadable/missing — treat as unknown */
  }
  return undefined;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Atomic takeover: rename the stale lock to a tombstone, then clean it up. */
function tombstone(lock: string): void {
  const grave = `${lock}.stale.${Date.now()}.${process.pid}`;
  try {
    fs.renameSync(lock, grave);
    fs.rmSync(grave, { recursive: true, force: true });
  } catch {
    /* someone else already took it over — loop and retry */
  }
}

type Attempt = { lock: string } | { heldBy: "self" } | { heldBy: "other"; pid?: number };

/**
 * One acquisition attempt. Success returns the lock path; otherwise reports
 * who holds it. A live, fresh hold by THIS process is surfaced distinctly:
 * a synchronous waiter on the same event loop can never outlive it (waiting
 * would starve the async holder), so callers fail fast instead of spinning.
 */
function tryAcquire(staleMs: number): Attempt {
  const lock = authorizationLockPath();
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
    fs.writeFileSync(
      path.join(lock, "owner"),
      JSON.stringify({ pid: process.pid, acquiredAt: Date.now() } satisfies Owner),
      { mode: 0o600 },
    );
    return { lock };
  } catch {
    const owner = readOwner(lock);
    // Unknown owner (mid-acquisition or corrupt): only reap if it stays
    // ownerless past the stale bound — mtime of the dir is the tiebreaker.
    if (!owner) {
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > staleMs) tombstone(lock);
      } catch {
        /* vanished between attempts — retry on next poll */
      }
      return { heldBy: "other" };
    }
    if (!pidAlive(owner.pid) || Date.now() - owner.acquiredAt > staleMs) {
      tombstone(lock);
      return { heldBy: "other", pid: owner.pid }; // freshly reaped — next poll acquires
    }
    if (owner.pid === process.pid) return { heldBy: "self" };
    return { heldBy: "other", pid: owner.pid };
  }
}

function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Synchronous acquire for the (sync) config-write path.
 *
 * - Held by ANOTHER process: block-spin up to `acquireTimeoutMs` (a foreign
 *   event loop keeps running; the hold is seconds).
 * - Held by THIS process (an in-flight approve section on the same event
 *   loop): throw {@link AuthorizationLockBusyError} IMMEDIATELY — spinning
 *   here would starve the very section we are waiting on. The admin surface
 *   reports it honestly ("approve in flight; retry shortly") instead of
 *   writing around the lock.
 */
export function acquireAuthorizationLockSync(opts: AuthorizationLockOptions = {}): string {
  const { acquireTimeoutMs, staleMs, pollMs } = { ...DEFAULTS, ...opts };
  const deadline = Date.now() + acquireTimeoutMs;
  for (;;) {
    const attempt = tryAcquire(staleMs);
    if ("lock" in attempt) return attempt.lock;
    if (attempt.heldBy === "self") throw new AuthorizationLockBusyError(process.pid);
    if (Date.now() >= deadline) {
      throw new AuthorizationLockBusyError(attempt.pid);
    }
    syncSleep(pollMs);
  }
}

export function releaseAuthorizationLock(lock: string): void {
  try {
    fs.rmSync(lock, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * In-process FIFO chain: two async sections in the SAME process serialize
 * here first (fair, no fs polling against ourselves), then take the file
 * lock to exclude OTHER processes.
 */
let inProcessChain: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` while holding the authorization lock (async acquire). Used by the
 * approve POST critical section: policy reads, preflights, and the POST all
 * happen under the same hold, excluding concurrent config writes.
 */
export function withAuthorizationLock<T>(
  fn: () => Promise<T> | T,
  opts: AuthorizationLockOptions = {},
): Promise<T> {
  const { acquireTimeoutMs, staleMs, pollMs } = { ...DEFAULTS, ...opts };
  const run = async (): Promise<T> => {
    const deadline = Date.now() + acquireTimeoutMs;
    let lock: string | undefined;
    for (;;) {
      const attempt = tryAcquire(staleMs);
      if ("lock" in attempt) {
        lock = attempt.lock;
        break;
      }
      // heldBy "self" can only mean a sync holder or a leaked release on this
      // pid — the chain already serialized async sections. Treat it like any
      // contended hold: poll until free or stale.
      if (Date.now() >= deadline) {
        throw new AuthorizationLockBusyError(
          attempt.heldBy === "other" ? attempt.pid : process.pid,
        );
      }
      await new Promise<void>((r) => setTimeout(r, pollMs));
    }
    try {
      return await fn();
    } finally {
      releaseAuthorizationLock(lock);
    }
  };
  // Chain regardless of the predecessor's outcome (its errors surface to its
  // own caller; the chain link swallows them so the queue never jams).
  const next = inProcessChain.then(run, run);
  inProcessChain = next.catch(() => undefined);
  return next;
}
