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
 *
 * Both guards also RECORD to the gateway event stream. Logging alone was the
 * original gap: the audit surfaces (`pmk gateway audit`, doctor, failure
 * tailers) all read events, so a log-only guard made its own interceptions
 * invisible to every downstream consumer.
 */
import { appendGatewayEvent, type GatewayEvent } from "./events";

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

/** Longest stack we put on disk. Enough to name the frame, bounded so a deep
 *  recursion crash can't write a megabyte into the audit partition. */
const MAX_STACK_CHARS = 2000;

/**
 * Record the failure on the event stream, never letting the recording itself
 * become a second failure. The audit write is best-effort by design
 * (see appendJsonl), but a caller-supplied emitter may throw, and neither
 * guard may die inside its own handler.
 */
function recordSafely(
  emit: (event: GatewayEvent) => void,
  event: GatewayEvent,
  log: (msg: string) => void,
): void {
  try {
    emit(event);
  } catch (err) {
    log(`[crash-guard] failed to record ${event.type}: ${describeRejection(err)}`);
  }
}

/**
 * The guard's handler (pure factory — testable without a real rejection).
 *
 * Emits a non-fatal `gateway.rejection` alongside the log line: a log reaches
 * only the operator's terminal, while `pmk gateway audit`, doctor, and event
 * tailers read the event stream. Without the event, the daemon survives a
 * failure that nothing downstream can ever see.
 */
export function makeRejectionHandler(
  log: (msg: string) => void,
  emit: (event: GatewayEvent) => void = appendGatewayEvent,
): (reason: unknown) => void {
  return (reason: unknown): void => {
    const description = describeRejection(reason);
    log(`[unhandledRejection] survived (gateway not crashing): ${description}`);
    recordSafely(
      emit,
      {
        type: "gateway.rejection",
        kind: "unhandledRejection",
        reason: description,
        fatal: false,
      },
      log,
    );
  };
}

/**
 * Handler for a synchronous throw that escaped every try/catch.
 *
 * Unlike a stray rejection, this one is NOT survivable: the process state is
 * unknown, so we record and then exit non-zero for the supervisor (launchd
 * `KeepAlive`) to restart a clean process. The value added over Node's default
 * crash is purely forensic — a bare crash orphans any in-flight detached review
 * (its mra/claude subprocesses keep running with no one awaiting them) and
 * leaves nothing on disk explaining why the gateway went away.
 */
export function makeUncaughtExceptionHandler(
  log: (msg: string) => void,
  emit: (event: GatewayEvent) => void = appendGatewayEvent,
  exit: (code: number) => void = (code) => process.exit(code),
): (err: unknown) => void {
  return (err: unknown): void => {
    const description = describeRejection(err);
    log(`[uncaughtException] FATAL — exiting for supervisor restart: ${description}`);
    const stack = err instanceof Error && err.stack ? err.stack.slice(0, MAX_STACK_CHARS) : undefined;
    recordSafely(
      emit,
      {
        type: "gateway.rejection",
        kind: "uncaughtException",
        reason: description,
        fatal: true,
        ...(stack ? { stack } : {}),
      },
      log,
    );
    exit(1);
  };
}

/**
 * Install the uncaught-exception guard. Records + exits(1); returns a disposer
 * (used by tests so they don't leak a global listener).
 */
export function installUncaughtExceptionGuard(
  log: (msg: string) => void,
): () => void {
  const handler = makeUncaughtExceptionHandler(log);
  process.on("uncaughtException", handler);
  return () => {
    process.off("uncaughtException", handler);
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
