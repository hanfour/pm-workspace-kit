import * as fs from "node:fs";
import * as path from "node:path";
import { SlackAdapter } from "./slack";
import {
  gatewayPidPath,
  hasValidSlackTokens,
  loadGatewayConfig,
} from "./config";
import {
  HEARTBEAT_INTERVAL_MS,
  clearHeartbeat,
  startHeartbeat,
} from "./heartbeat";

export interface GatewayRunOptions {
  /** Called for each one-line breadcrumb. Defaults to console.log. */
  onLog?: (msg: string) => void;
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

  const adapter = new SlackAdapter({
    config: cfg,
    onLog: log,
    wasOffline: hb.wasOffline,
    lastSeenAt: hb.lastSeenAt,
  });

  writePidFile();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down…`);
    hb.stop();
    clearHeartbeat();
    try {
      await adapter.stop();
    } catch (err) {
      log(`adapter stop error: ${(err as Error).message}`);
    }
    removePidFile();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    const info = await adapter.start();
    log(
      `gateway up. Slack=${info.workspaceName} botUser=<@${info.botUserId}>. Ctrl+C to stop.`,
    );
  } catch (err) {
    hb.stop();
    clearHeartbeat();
    removePidFile();
    throw err;
  }

  // Block forever; SIGINT/SIGTERM handlers exit.
  await new Promise(() => {});
}

function writePidFile(): void {
  try {
    fs.writeFileSync(gatewayPidPath(), process.pid.toString(), "utf8");
  } catch {
    /* non-fatal */
  }
}

function removePidFile(): void {
  try {
    fs.unlinkSync(gatewayPidPath());
  } catch {
    /* may already be gone */
  }
}

/**
 * Read the PID file and best-effort check if that PID is alive.
 * Returns the PID if a gateway appears to be running, undefined otherwise.
 */
export function gatewayRunningPid(): number | undefined {
  const file = gatewayPidPath();
  if (!fs.existsSync(file)) return undefined;
  const pid = parseInt(fs.readFileSync(file, "utf8").trim(), 10);
  if (!Number.isFinite(pid)) return undefined;
  try {
    process.kill(pid, 0); // signal 0 = liveness check
    return pid;
  } catch {
    // PID stale — clean up so future status checks are accurate.
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
    return undefined;
  }
}
