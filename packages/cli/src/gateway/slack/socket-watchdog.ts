/**
 * Self-heal watchdog for the Socket-Mode connection. On an unhealthy
 * verdict it forces an in-process reconnect; a reconnect is only
 * "failed" if the socket goes unhealthy again before
 * STABLE_CONNECTED_RESET_MS of continuous health (or its reconnect
 * throws/times out). After REUNHEALTHY_ATTEMPTS confirmed failures the
 * next unhealthy tick performs a loud exit. The single-flight flag
 * guards only the watchdog's OWN reconnect — SDK auto-reconnect churn is
 * caught by assess()'s UNSTABLE_CONN_LIMIT_MS and is NOT skipped.
 */
import type { SocketHealth } from "../socket-health";

/** Confirmed-failed reconnects before loud exit. */
export const REUNHEALTHY_ATTEMPTS = 3;
/** Continuous connected+no-pong-timeout needed to reset the failure counter. */
export const STABLE_CONNECTED_RESET_MS = 180_000;
/** Per-reconnect cap; timing out = a failed reconnect (can't pin in-flight). */
export const WATCHDOG_RECONNECT_TIMEOUT_MS = 45_000;
/** Hard cap on the loud-exit admin-alert phase. */
export const WATCHDOG_ALERT_TIMEOUT_MS = 15_000;
/** Evaluation cadence (dedicated timer — heartbeat exposes no hook). */
export const WATCHDOG_INTERVAL_MS = 30_000;

export interface SocketWatchdogDeps {
  health: SocketHealth;
  /** Rebuild the connection (adapter: disconnect() then start()). */
  reconnect: () => Promise<void>;
  /** Loud-exit alert (adapter: presence.watchdogTerminate(...)). */
  terminate: () => Promise<void>;
  exit: (code: number) => void;
  now: () => number;
  onLog: (msg: string) => void;
  /** Override for tests; defaults to WATCHDOG_RECONNECT_TIMEOUT_MS. */
  reconnectTimeoutMs?: number;
}

/** Collaborators the SlackAdapter feeds into {@link makeAdapterWatchdogDeps}. */
export interface AdapterWatchdogWiring {
  health: SocketHealth;
  socket: { disconnect(): Promise<unknown>; start(): Promise<unknown> };
  presence: {
    watchdogTerminate(o: {
      adminIds: string[];
      attempts: number;
      alertTimeoutMs: number;
    }): Promise<void>;
  };
  admins: string[];
  onLog: (msg: string) => void;
  /** Defaults to process.exit; injectable for tests. */
  exit?: (code: number) => void;
  /** Defaults to Date.now; injectable for tests. */
  now?: () => number;
}

/**
 * Build the production `SocketWatchdogDeps` the SlackAdapter uses — the
 * reconnect / terminate / exit / now closures. Extracted as a pure factory
 * so this wiring is unit-testable: the adapter only constructs a watchdog
 * under a real socket (`realTransport`), so the fake-transport test harness
 * can't exercise these closures without risking a real `process.exit`.
 */
export function makeAdapterWatchdogDeps(
  w: AdapterWatchdogWiring,
): SocketWatchdogDeps {
  return {
    health: w.health,
    reconnect: async () => {
      await w.socket.disconnect();
      await w.socket.start();
    },
    terminate: () =>
      w.presence.watchdogTerminate({
        adminIds: w.admins,
        attempts: REUNHEALTHY_ATTEMPTS,
        alertTimeoutMs: WATCHDOG_ALERT_TIMEOUT_MS,
      }),
    exit: w.exit ?? ((code) => process.exit(code)),
    now: w.now ?? (() => Date.now()),
    onLog: w.onLog,
  };
}

export class SocketWatchdog {
  private timer?: ReturnType<typeof setInterval>;
  private failedReconnects = 0;
  private inFlight = false;
  private pendingEvaluation = false;

  constructor(private readonly deps: SocketWatchdogDeps) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), WATCHDOG_INTERVAL_MS);
    if (this.timer && typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    const now = this.deps.now();
    if (this.deps.health.assess(now) === "healthy") {
      const stableSince = this.deps.health.lastStableConnectedSince(now);
      if (stableSince !== null && now - stableSince >= STABLE_CONNECTED_RESET_MS) {
        if (this.failedReconnects > 0 || this.pendingEvaluation) {
          this.deps.onLog("watchdog: socket stable; clearing reconnect failure count");
        }
        this.failedReconnects = 0;
        this.pendingEvaluation = false;
      }
      return;
    }

    // unhealthy
    if (this.inFlight) return; // our own reconnect is mid-flight

    if (this.pendingEvaluation) {
      this.failedReconnects += 1;
      this.pendingEvaluation = false;
      this.deps.onLog(`watchdog: reconnect #${this.failedReconnects} did not stabilise`);
    }

    if (this.failedReconnects >= REUNHEALTHY_ATTEMPTS) {
      this.deps.onLog(
        `watchdog: Socket-Mode unrecoverable after ${this.failedReconnects} reconnects; loud exit`,
      );
      try {
        await withTimeout(this.deps.terminate(), WATCHDOG_ALERT_TIMEOUT_MS);
      } catch (err) {
        this.deps.onLog(
          `watchdog: loud-exit alert failed (${err instanceof Error ? err.message : String(err)}); exiting anyway`,
        );
      } finally {
        this.deps.exit(1);
      }
      return;
    }

    await this.forceReconnect();
  }

  private async forceReconnect(): Promise<void> {
    this.inFlight = true;
    const timeoutMs = this.deps.reconnectTimeoutMs ?? WATCHDOG_RECONNECT_TIMEOUT_MS;
    try {
      // The spec phrases the cap as per-step (disconnect, then start); we
      // race the whole reconnect() thunk against one timeout instead. That
      // is equivalent-or-stricter for the only thing the cap must guarantee
      // — that a wedged reconnect can never pin `inFlight` forever — and it
      // bounds the *total* reconnect time rather than 2× a per-step budget.
      await withTimeout(this.deps.reconnect(), timeoutMs);
      this.deps.health.reset(this.deps.now());
      this.pendingEvaluation = true;
      this.deps.onLog("watchdog: forced reconnect issued, awaiting stability");
    } catch (err) {
      this.failedReconnects += 1;
      this.pendingEvaluation = false;
      this.deps.onLog(
        `watchdog: forced reconnect failed (${err instanceof Error ? err.message : String(err)}); failures=${this.failedReconnects}`,
      );
    } finally {
      this.inFlight = false;
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`reconnect timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeoutP]).then(
    (v) => { clearTimeout(timer); return v; },
    (e: Error) => { clearTimeout(timer); return Promise.reject(e); },
  );
}
