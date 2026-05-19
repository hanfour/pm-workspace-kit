/**
 * Bounded-concurrency task runner used by the presence-broadcast
 * fan-out (#44). Lives in its own module so consumers (presence
 * broadcaster, future fan-out call sites) can import it without
 * pulling in the whole `slack/index.ts` graph.
 *
 * Errors per task are intentionally swallowed — see the broadcast
 * call-site comment in `slack/presence.ts` for the rationale (one
 * rejected DM must not abort the rest of the fan-out).
 */

/**
 * Run `tasks` with at most `limit` in flight at once. Settles all
 * tasks (swallowing per-task errors) and resolves once the queue
 * drains. Returns immediately when `tasks.length === 0`.
 */
export async function runWithConcurrency(
  limit: number,
  tasks: Array<() => Promise<unknown>>,
): Promise<void> {
  if (tasks.length === 0) return;
  const queue = [...tasks];
  const workerCount = Math.min(limit, queue.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length) {
      const fn = queue.shift();
      if (!fn) return;
      try {
        await fn();
      } catch {
        /* swallowed by design — see broadcast() */
      }
    }
  });
  await Promise.all(workers);
}
