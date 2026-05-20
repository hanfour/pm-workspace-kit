/**
 * Per-key FIFO work queue (v0.13 follow-up to #53).
 *
 * Replaces the pre-v0.13 "drop second message + busy notice" model
 * (which was misleading — the notice said `:hourglass: 你上一則訊息還在處理，請稍候。`
 * implying queue semantics, but the handler returned early and the
 * message was lost). With this queue, rapid follow-up messages from
 * the same user behind their own in-flight LLM round get queued FIFO
 * up to `maxDepth`, then drained automatically when the running work
 * completes.
 *
 * Key choice is the caller's: `userId` for DM, `${channelId}:${userId}`
 * for channel @-mention. The queue itself doesn't care.
 *
 * Bounded: when the queue for a key hits `maxDepth`, `enqueue` throws
 * `QueueFullError` so the caller can post an explicit "queue full"
 * rejection notice (better UX than silently dropping the Nth message).
 */

/** Default queue depth. 3 follow-ups feels like a reasonable ceiling for
 *  rapid-fire clarifications without letting one user monopolise the bot. */
export const DEFAULT_MAX_DEPTH = 3;

export class QueueFullError extends Error {
  readonly key: string;
  readonly depth: number;
  constructor(key: string, depth: number) {
    super(`InFlightQueue full for key "${key}" (depth ${depth})`);
    this.name = "QueueFullError";
    this.key = key;
    this.depth = depth;
  }
}

export type EnqueueResult = "ran" | "queued";

export interface InFlightQueueOptions {
  /** Max queued items per key (excluding the one currently running). Default 3. */
  maxDepth?: number;
  /** Diagnostic log for swallowed work errors. Default: no-op. */
  onLog?: (msg: string) => void;
}

export class InFlightQueue {
  private readonly queues = new Map<string, Array<() => Promise<void>>>();
  private readonly workers = new Map<string, Promise<void>>();
  private readonly maxDepth: number;
  private readonly onLog: (msg: string) => void;

  constructor(opts: InFlightQueueOptions = {}) {
    this.maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.onLog = opts.onLog ?? (() => {});
  }

  /**
   * Submit `work` for sequential execution under `key`.
   *
   * - If nothing is running for `key`: spawns a worker that runs
   *   `work` immediately, returns `"ran"`.
   * - If a worker is already running: appends `work` to the queue,
   *   returns `"queued"`. Caller can post a "queued, will process" notice.
   * - If the queue is at `maxDepth`: throws `QueueFullError`. Caller
   *   should post an explicit "rejected" notice.
   *
   * `enqueue` is synchronous (no promise). The submitted work runs
   * in the background via the worker; errors thrown by `work` are
   * caught and logged via `onLog` so one failed turn doesn't poison
   * the rest of the queue.
   */
  enqueue(key: string, work: () => Promise<void>): EnqueueResult {
    if (this.workers.has(key)) {
      const queue = this.queues.get(key) ?? [];
      if (queue.length >= this.maxDepth) {
        throw new QueueFullError(key, queue.length);
      }
      queue.push(work);
      this.queues.set(key, queue);
      return "queued";
    }
    const queue = this.queues.get(key) ?? [];
    queue.push(work);
    this.queues.set(key, queue);
    const worker = this.drain(key);
    this.workers.set(key, worker);
    return "ran";
  }

  private async drain(key: string): Promise<void> {
    try {
      const queue = this.queues.get(key);
      while (queue && queue.length > 0) {
        const work = queue.shift()!;
        try {
          await work();
        } catch (err) {
          // `onLog` is caller-supplied — wrap in its own try/catch so a
          // broken logger can't reject the worker promise (which would
          // poison `waitForAll` and force-fail graceful shutdown).
          try {
            this.onLog(
              `inflight-queue work failed for ${key}: ${(err as Error).message}`,
            );
          } catch {
            /* logger threw; nothing useful to do here */
          }
        }
      }
    } finally {
      // Cleanup must run even if something above unexpectedly throws —
      // otherwise the worker dies but `workers`/`queues` still claim
      // the key as active, locking that user out forever.
      this.queues.delete(key);
      this.workers.delete(key);
    }
  }

  /** Number of items currently QUEUED (not counting the running one). */
  depth(key: string): number {
    return this.queues.get(key)?.length ?? 0;
  }

  /** Is there a worker actively running for this key? */
  busy(key: string): boolean {
    return this.workers.has(key);
  }

  /** Wait until the worker for `key` drains. Useful for graceful shutdown
   *  and for tests that need to observe post-drain state. */
  async waitIdle(key: string): Promise<void> {
    const worker = this.workers.get(key);
    if (worker) await worker;
  }

  /** Wait for all currently-active workers across every key. Tests call
   *  this between an `emit` and the assert; production callers can use
   *  it on graceful shutdown to let in-flight LLM rounds complete. */
  async waitForAll(): Promise<void> {
    const workers = Array.from(this.workers.values());
    await Promise.all(workers);
  }
}
