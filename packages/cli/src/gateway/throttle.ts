/**
 * Last-line-wins throttle (v0.10 / #22).
 *
 * Used by the Slack adapter to drip-feed `mra ask` progress lines into
 * a placeholder message via `web.chat.update` without spamming Slack's
 * rate limit. A 3s window with leading + trailing fire is the right
 * compromise:
 *
 *   - first line shows immediately so the user sees movement
 *   - lines within the window are coalesced; only the latest renders
 *   - if mra falls silent after a leading fire, no redundant trailing
 *     update fires (the placeholder already shows the only line)
 *
 * Trailing fire is suppressed when the latest seen line equals the
 * line that already rendered — that case happens when a single line
 * arrives at a quiet moment and there's nothing further to drip.
 *
 * `cancel()` clears any scheduled trailing fire — call it after the
 * subprocess completes so the final synthesis reply isn't briefly
 * over-written by a stale progress line that lost the race.
 */

export interface LastLineThrottleOptions {
  /** Coalescing window in milliseconds. */
  windowMs: number;
  /** Sink for fired lines. May throw — caller's exceptions are swallowed. */
  onFire: (line: string) => void;
}

export interface LastLineThrottle {
  /** Record a line; may fire onFire synchronously (leading edge). */
  push: (line: string) => void;
  /** Cancel any pending trailing fire. Idempotent. */
  cancel: () => void;
}

export function createLastLineThrottle(
  opts: LastLineThrottleOptions,
): LastLineThrottle {
  let inWindow = false;
  let lastFired: string | undefined;
  let pendingLatest: string | undefined;
  let timer: NodeJS.Timeout | undefined;

  const safeFire = (line: string): void => {
    lastFired = line;
    try {
      opts.onFire(line);
    } catch {
      /* sink failures are not the producer's problem */
    }
  };

  const scheduleTrailing = (): void => {
    timer = setTimeout(() => {
      timer = undefined;
      inWindow = false;
      if (pendingLatest !== undefined && pendingLatest !== lastFired) {
        safeFire(pendingLatest);
      }
      pendingLatest = undefined;
    }, opts.windowMs);
  };

  return {
    push(line: string) {
      if (!inWindow) {
        inWindow = true;
        safeFire(line);
        pendingLatest = undefined;
        scheduleTrailing();
        return;
      }
      pendingLatest = line;
    },
    cancel() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      inWindow = false;
      pendingLatest = undefined;
    },
  };
}
