/**
 * Crash guard for the long-running gateway daemon (C3).
 *
 * Node's default `--unhandled-rejections=throw` kills the whole process on a
 * stray unhandled promise rejection. The `@slack/socket-mode` client
 * occasionally rejects with `undefined` during reconnect churn (App Nap / pong
 * timeouts) — observed live crashing the gateway and ORPHANING any in-flight
 * detached review (the review's mra/claude subprocesses keep running but the
 * gateway that was awaiting them is gone, so the result is never posted).
 *
 * A daemon must survive that. We register a process-level handler that logs the
 * rejection loudly and KEEPS RUNNING. Genuine, unrecoverable socket failure is
 * still handled deliberately by the socket-watchdog's loud-exit path — this
 * guard only stops an incidental library rejection from taking the whole
 * process down with it.
 */

/** Human-readable one-liner for an unhandled-rejection reason (pure, testable). */
export function describeRejection(reason: unknown): string {
  if (reason instanceof Error) {
    return `${reason.name}: ${reason.message}`;
  }
  if (reason === undefined || reason === null) {
    return `${String(reason)} (likely @slack/socket-mode reconnect churn)`;
  }
  if (typeof reason === "object") {
    try {
      return JSON.stringify(reason).slice(0, 300);
    } catch {
      return Object.prototype.toString.call(reason);
    }
  }
  return String(reason);
}

/** The guard's handler (pure factory — testable without a real rejection). */
export function makeRejectionHandler(
  log: (msg: string) => void,
): (reason: unknown) => void {
  return (reason: unknown): void => {
    log(
      `[unhandledRejection] survived (gateway not crashing): ${describeRejection(reason)}`,
    );
  };
}

/**
 * Install the unhandled-rejection guard. Logs + continues (does NOT exit).
 * Registering ANY `unhandledRejection` listener suppresses Node's default
 * `--unhandled-rejections=throw` crash, so a registered handler is what keeps
 * the daemon alive. Returns a disposer that removes the handler (used by tests
 * so they don't leak a global listener; production never disposes — it lives
 * for the process lifetime).
 */
export function installUnhandledRejectionGuard(
  log: (msg: string) => void,
): () => void {
  const handler = makeRejectionHandler(log);
  process.on("unhandledRejection", handler);
  return () => {
    process.off("unhandledRejection", handler);
  };
}
