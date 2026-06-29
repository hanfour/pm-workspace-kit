import * as path from "node:path";
import * as fs from "node:fs";
import { SlackAdapter } from "./slack";
import { createDryRunStats } from "./slack/dry-run-wrapper";
import {
  hasValidSlackTokens,
  loadGatewayConfig,
} from "./config";
import {
  writeRunState,
  removeRunState,
  readGatewayRunStateRaw,
  gatewayLiveRunState,
} from "./run-state";
import {
  HEARTBEAT_INTERVAL_MS,
  clearHeartbeat,
  markGracefulShutdown,
  startHeartbeat,
} from "./heartbeat";
import { startKeepAwake } from "./keep-awake";
import { installUnhandledRejectionGuard } from "./crash-guard";
import { recoverReviewClaims } from "./review-claim";
import { sweepStaleAudioTemp } from "./audio/temp";
import { sweepStaleAudioClaims } from "./audio/claim";
import { sweepStaleAtomMarkers } from "./audio/atom-marker";

export interface GatewayRunOptions {
  /** Called for each one-line breadcrumb. Defaults to console.log. */
  onLog?: (msg: string) => void;
  /**
   * v0.16 (M3 / FR3): when true, sets PMK_DRY_RUN=1 so all Slack
   * writes are stubbed at the outermost WebClient wrapper and events
   * are written to `dryrun-events-YYYY-MM.log`. Read methods + the
   * underlying SocketMode connection still run normally; the gateway
   * fully exercises the retrieval → LLM → escalation path but emits
   * zero Slack side effects.
   */
  dryRun?: boolean;
}

/**
 * Run the gateway: loads config, starts heartbeat + Slack adapter,
 * waits for SIGINT/SIGTERM, broadcasts offline + cleans up.
 *
 * Foreground only — no daemonisation. The host runs this in a
 * persistent terminal, tmux pane, etc.
 */
export async function runGateway(opts: GatewayRunOptions = {}): Promise<void> {
  const log = opts.onLog ?? ((m: string) => console.log(`[pmk-gw] ${m}`));
  if (opts.dryRun) {
    process.env.PMK_DRY_RUN = "1";
    log("");
    log("============================================================");
    log("  DRY-RUN MODE — no Slack writes will be sent.");
    log("  Events partition: dryrun-events-YYYY-MM.log");
    log("  Exit with Ctrl+C to see session metrics.");
    log("============================================================");
    log("");
  }
  const cfg = loadGatewayConfig();
  if (!hasValidSlackTokens(cfg)) {
    throw new Error(
      "gateway not configured. Run `pmk gateway init` and paste your Slack tokens.",
    );
  }

  // Pre-flight validate the configured mra workspace so the host
  // catches a stale path at start-up, not at first DM. Non-fatal —
  // mra-ask will degrade gracefully later either way.
  if (cfg.mraWorkspace) {
    const marker = path.join(cfg.mraWorkspace, ".collab", "repos.json");
    if (!fs.existsSync(marker)) {
      log(
        `WARN: mraWorkspace='${cfg.mraWorkspace}' has no .collab/repos.json — mra-ask will fail until you run \`mra init\` there or fix the path with \`pmk gateway init\``,
      );
    } else {
      log(`mra workspace: ${cfg.mraWorkspace}`);
    }
  } else {
    log(
      "mra workspace: not configured (set via `pmk gateway init`); falling back to launch-cwd walk",
    );
  }

  const hb = startHeartbeat();
  if (hb.wasOffline) {
    log(
      `host was offline (last seen ${
        hb.lastSeenAt ? new Date(hb.lastSeenAt).toISOString() : "never"
      }); will broadcast back-online once Slack is connected`,
    );
  }
  log(`heartbeat ticking every ${HEARTBEAT_INTERVAL_MS / 1000}s`);
  const keepAwake = startKeepAwake({ onLog: log });

  // B: self-heal review claims orphaned by a previous instance that
  // crashed/restarted mid-review (claimed but never finalized) — release them
  // so the PR can be re-`:cr:`-reviewed instead of falsely reporting "already
  // reviewed". The stale window (45 min) exceeds the longest review (on-demand
  // PKB build ~15m + debate ~20m) so a still-finishing orphaned mra isn't
  // released out from under it (which would risk a duplicate review).
  const REVIEW_STALE_CLAIM_MS = 45 * 60 * 1000;
  const recoveredClaims = recoverReviewClaims(REVIEW_STALE_CLAIM_MS, log);
  if (recoveredClaims > 0) {
    log(`recovered ${recoveredClaims} orphaned review claim(s) from a prior run`);
  }

  const sweptTempDirs = sweepStaleAudioTemp();
  if (sweptTempDirs > 0) {
    log(`swept ${sweptTempDirs} stale audio temp dir(s) from a prior run`);
  }

  const sweptClaims = sweepStaleAudioClaims();
  if (sweptClaims > 0) {
    log(`swept ${sweptClaims} stale audio claim(s) from a prior run`);
  }

  const sweptMarkers = sweepStaleAtomMarkers();
  if (sweptMarkers > 0) {
    log(`swept ${sweptMarkers} stale audio-atom marker(s) from a prior run`);
  }

  const dryRunStats = opts.dryRun ? createDryRunStats() : undefined;
  const adapter = new SlackAdapter({
    config: cfg,
    onLog: log,
    wasOffline: hb.wasOffline,
    lastSeenAt: hb.lastSeenAt,
    offlineDurationMs: hb.offlineDurationMs,
    gracefulShutdown: hb.gracefulShutdown,
    dryRun: opts.dryRun,
    dryRunOpts: dryRunStats ? { stats: dryRunStats } : undefined,
  });

  const supervised: "launchd" | null = process.env.PMK_SERVICE === "launchd" ? "launchd" : null;
  const serviceLabel = process.env.PMK_SERVICE_LABEL;

  writeRunState({
    pid: process.pid,
    startedAt: Date.now(),
    phase: "starting",
    supervised,
    serviceLabel,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down…`);
    hb.stop();
    keepAwake.stop();
    // #44: write a single-use graceful-shutdown marker BEFORE
    // stopping the adapter (which broadcasts offline). If the marker
    // write fails or shutdown is interrupted we degrade to crash
    // semantics on next start — cosmetic broadcast spam, no
    // functional regression. Note: we deliberately do NOT call
    // clearHeartbeat() here — the next startHeartbeat() needs to see
    // the prior heartbeat timestamp to compute offlineDurationMs
    // accurately.
    markGracefulShutdown();
    try {
      // 90s drain budget. The drain awaits queued / in-flight free-chat turns
      // so users who saw "已排入隊伍" actually get their replies AND the
      // per-turn "服務重新啟動" restart notices have time to post; if a stuck
      // LLM round blows the budget we log + proceed so SIGKILL isn't what reaps
      // the process. `pmk gateway restart` waits ≥95s (see ops.awaitProcessExit)
      // so this full drain finishes before a new instance starts.
      await adapter.stop({ drainTimeoutMs: 90_000 });
    } catch (err) {
      log(`adapter stop error: ${(err as Error).message}`);
    }
    if (dryRunStats) {
      log("");
      log("=== dry-run session metrics ===");
      log(`  chat.postMessage stubbed:   ${dryRunStats.postMessage}`);
      log(`  chat.postEphemeral stubbed: ${dryRunStats.postEphemeral}`);
      log(`  reactions.add stubbed:      ${dryRunStats.reactionAdd}`);
      log(`  other writes stubbed:       ${dryRunStats.otherWrites}`);
      log(
        "  (retrieval / LLM token / escalation counters live in dryrun-events-YYYY-MM.log)",
      );
    }
    removeRunState();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // C3: don't let a stray unhandled rejection (e.g. @slack/socket-mode
  // rejecting with `undefined` during reconnect churn) crash the daemon and
  // orphan in-flight reviews. Log + keep running; the socket-watchdog still
  // owns deliberate loud-exit on genuine unrecoverable socket failure.
  installUnhandledRejectionGuard(log);

  try {
    const info = await adapter.start();
    const prev = readGatewayRunStateRaw();
    writeRunState({
      pid: process.pid,
      startedAt: prev?.startedAt ?? Date.now(), // file race on startup — fall back to now (off by < adapter.start() duration)
      phase: "ready",
      supervised,
      serviceLabel,
    });
    log(
      `gateway up. Slack=${info.workspaceName} botUser=<@${info.botUserId}>. Ctrl+C to stop.`,
    );
  } catch (err) {
    hb.stop();
    keepAwake.stop();
    clearHeartbeat();
    removeRunState();
    throw err;
  }

  // Block forever; SIGINT/SIGTERM handlers exit.
  await new Promise(() => {});
}

/**
 * Read the run-state file and best-effort check if that PID is alive.
 * Returns the PID if a gateway appears to be running, undefined otherwise.
 */
export function gatewayRunningPid(): number | undefined {
  return gatewayLiveRunState()?.pid;
}
