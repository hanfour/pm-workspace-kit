import * as readline from "node:readline/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import chalk from "chalk";
import { println } from "../../io";
import {
  type RawGatewayConfig,
  gatewayConfigPath,
  gatewayDir,
  loadRawGatewayConfig,
  saveGatewayConfig,
} from "../../gateway/config";
import { type SecretSource } from "../../gateway/secret-source";
import { gatewayRunningPid, runGateway } from "../../gateway";
import { userStats } from "../../gateway/session-store";
import { findMraWorkspace } from "../../adapters/mra";
import { buildAuditReport } from "../../gateway/audit";
import { formatAuditReport } from "../../gateway/audit-format";
import {
  buildDoctorContext,
  formatDoctorReport,
  runDoctor,
} from "../../gateway/doctor";
import { DEFAULT_CHECKS } from "../../gateway/doctor-checks";
import {
  seedDemoAtom,
  unseedDemoAtoms,
} from "../../gateway/demo-seed";
import {
  readGatewayRunStateRaw,
  gatewayLiveRunState,
  installedPlist,
  loadedService,
  serviceLabelValid,
  SERVICE_LABEL,
} from "../../gateway/run-state";
import { lastHeartbeatAt } from "../../gateway/heartbeat";
import { readGatewayEvents, RECENT_ACTIVITY_WINDOW_MS } from "../../gateway/events";
import { verdict } from "../../gateway/health-verdict";

/**
 * `pmk gateway demo <seed|unseed>` — smoke-test data for onboarding.
 *
 * `seed`   writes one KnowledgeAtom tagged `demo-seed` so a new host
 *          can verify the retrieval path immediately after install.
 *          Idempotent: re-running doesn't duplicate.
 * `unseed` removes every atom tagged `demo-seed`. Never touches real
 *          atoms; safe to run as the last step of an onboarding
 *          rehearsal.
 *
 * Polished AcmeAds demo bundle (multi-PRD, walkthrough script,
 * recorded run) is priorities-plan P5, NOT this command.
 */
export function demoCmd(rest: string[]): void {
  const action = rest[0];
  switch (action) {
    case "seed": {
      const r = seedDemoAtom();
      if (r.written) {
        println(chalk.green(`✓ wrote demo atom: ${r.atomId}`));
        println(chalk.dim(`  file: ${r.filePath}`));
      } else {
        println(
          chalk.yellow(
            `demo atom already present (id=${r.atomId}); no changes written.`,
          ),
        );
        println(chalk.dim(`  file: ${r.filePath}`));
      }
      println("");
      println(chalk.bold("next step (smoke test):"));
      println(`  1. start the gateway:  pmk gateway start`);
      println(`  2. in Slack, DM the bot or @-mention it with:`);
      println(chalk.cyan(`       ${r.question}`));
      println("  3. you should see the bot quote the demo answer.");
      println("");
      println(chalk.dim("clean up later with: pmk gateway demo unseed"));
      return;
    }
    case "unseed": {
      const r = unseedDemoAtoms();
      if (r.removed.length === 0) {
        println(chalk.yellow("no demo atoms found; nothing to remove."));
      } else {
        println(chalk.green(`✓ removed ${r.removed.length} demo atom(s):`));
        for (const id of r.removed) println(chalk.dim(`    - ${id}`));
      }
      return;
    }
    default:
      println(chalk.yellow("usage: pmk gateway demo <seed|unseed>"));
      process.exit(1);
  }
}

/**
 * `pmk gateway doctor [--json]` — pre-flight check before runtime.
 * Read-only: never writes config, never posts to Slack. Exit code 1
 * if any check FAILs, 0 otherwise (WARNs are non-fatal).
 *
 * --json emits the structured report for CI / hooks.
 */
export async function doctorCmd(rest: string[]): Promise<void> {
  const json = rest.includes("--json");
  const ctx = buildDoctorContext();
  const report = await runDoctor(ctx, DEFAULT_CHECKS);
  println(formatDoctorReport(report, { json }));
  if (report.failed > 0) {
    process.exit(1);
  }
}

/**
 * `pmk gateway audit [--days N]` — operator-facing rollup of the
 * knowledge loop's recent activity. Default window is 7 days.
 *
 * The number `--days` cap exists so an operator who types `--days 999`
 * doesn't accidentally scan years of events for a hosted gateway. 365
 * is generous; bump if real workloads need it.
 */
export function auditCmd(rest: string[]): void {
  const daysIdx = rest.indexOf("--days");
  let days = 7;
  if (daysIdx >= 0) {
    const raw = rest[daysIdx + 1];
    const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      println(
        chalk.red(
          `invalid --days '${raw ?? ""}'. Expected a positive integer (e.g. --days 14).`,
        ),
      );
      process.exit(1);
    }
    if (parsed > 365) {
      println(
        chalk.yellow(
          `  warning: --days ${parsed} clamped to 365. Open an issue if you need a longer audit window.`,
        ),
      );
      days = 365;
    } else {
      days = parsed;
    }
  }
  const report = buildAuditReport({ days });
  println("");
  println(formatAuditReport(report));
}

/**
 * Build the RawGatewayConfig to persist. A typed value (new literal) replaces;
 * blank ("") preserves the existing raw SecretSource (incl. {cmd}/{env}).
 *
 * Exported so initCmd can be unit-tested without stdin.
 */
export function buildInitConfig(args: {
  existing: RawGatewayConfig;
  appTokenTyped?: string;
  botTokenTyped?: string;
  apiKeyTyped?: string;
}): RawGatewayConfig {
  const appToken = args.appTokenTyped?.trim() || args.existing.slack.appToken;
  const botToken = args.botTokenTyped?.trim() || args.existing.slack.botToken;
  const apiKey = args.apiKeyTyped?.trim() || args.existing.apiKey;
  return {
    ...args.existing,
    apiKey,
    slack: { ...args.existing.slack, appToken, botToken },
  };
}

/** True when a token value is present and, if the user just typed a
 * fresh literal, has the required prefix. A preserved reference ({cmd}/{env})
 * passes without prefix checking — we can't resolve it here. */
function presentAndFormatOk(
  typed: string,
  value: SecretSource | undefined,
  prefix: string,
): boolean {
  if (value === undefined) return false;
  if (typed && typeof value === "string") return value.startsWith(prefix);
  // preserved reference/literal (or a non-string value the builder kept) — passes without resolving
  return true;
}

export async function initCmd(): Promise<void> {
  const existing = loadRawGatewayConfig();
  println(chalk.bold("\npmk gateway — initial setup"));
  println(
    chalk.dim(
      "  This writes ~/.pmk/gateway.json with your Slack app credentials.",
    ),
  );
  println(
    chalk.dim(
      "  Both tokens are written with mode 0600. To rotate later, run init again or edit the file.",
    ),
  );
  println("");
  println(chalk.dim("  Slack app setup (one-time, ~5 min):"));
  println(
    chalk.dim(
      "    1. Open https://api.slack.com/apps?new_app=1 → 'From a manifest'",
    ),
  );
  println(chalk.dim("    2. Paste the contents of:"));
  println(
    chalk.dim(
      "         packages/cli/src/gateway/slack/manifest.template.json",
    ),
  );
  println(chalk.dim("       (or use the raw URL:"));
  println(
    chalk.dim(
      "         https://raw.githubusercontent.com/hanfour/pm-workspace-kit/main/packages/cli/src/gateway/slack/manifest.template.json )",
    ),
  );
  println(chalk.dim("    3. Install to Workspace, then copy:"));
  println(
    chalk.dim(
      "         - App-Level Token (xapp-...)  — auto-generated for Socket Mode",
    ),
  );
  println(chalk.dim("         - Bot User OAuth Token (xoxb-...)"));
  println(
    chalk.dim(
      "    (blank = keep current; inject via PMK_SLACK_* / op run, or hand-edit gateway.json to use a {\"cmd\":\"...\"} / {\"env\":\"...\"} reference)",
    ),
  );
  println("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const appTokenInput = (
      await rl.question(
        chalk.cyan(
          `App-Level Token (xapp-...) ${existing.slack.appToken ? "[unchanged on enter]" : ""}: `,
        ),
      )
    ).trim();
    const botTokenInput = (
      await rl.question(
        chalk.cyan(
          `Bot Token (xoxb-...) ${existing.slack.botToken ? "[unchanged on enter]" : ""}: `,
        ),
      )
    ).trim();
    const defaultIngest =
      (
        await rl.question(
          chalk.cyan(
            `Default ingest spec (e.g. mra:--all, blank for none) ${existing.defaultIngest ?? ""}: `,
          ),
        )
      ).trim() || existing.defaultIngest;

    // mra workspace path. Auto-detect from cwd if the user is sitting
    // inside one; otherwise leave blank so the gateway uses the launch
    // cwd at runtime (v0.7.0 behaviour). Stored as absolute path.
    const detected = findMraWorkspace(process.cwd());
    const suggestion = existing.mraWorkspace ?? detected ?? "";
    const mraWorkspaceRaw = (
      await rl.question(
        chalk.cyan(
          `mra workspace path (where .collab/repos.json lives) ${
            suggestion ? `[${suggestion}]` : "[blank to skip]"
          }: `,
        ),
      )
    ).trim();
    const mraWorkspace = mraWorkspaceRaw
      ? path.resolve(
          mraWorkspaceRaw.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"),
        )
      : suggestion || undefined;
    if (
      mraWorkspace &&
      !fs.existsSync(path.join(mraWorkspace, ".collab", "repos.json"))
    ) {
      println(
        chalk.yellow(
          `  warning: '${mraWorkspace}' has no .collab/repos.json. mra-ask will fail until you run \`mra init\` there.`,
        ),
      );
    }

    println("");
    println(
      chalk.dim(
        "  v0.12+: pmk gateway prefers the Anthropic API directly (no SDK overhead).",
      ),
    );
    println(
      chalk.dim(
        "    If you skip this prompt, set ANTHROPIC_API_KEY in your environment, or",
      ),
    );
    println(
      chalk.dim(
        "    keep the legacy claude-agent path with PMK_PROVIDER=claude-agent.",
      ),
    );
    const apiKeyInput = (
      await rl.question(
        chalk.cyan(
          `Anthropic API key (sk-ant-...) ${existing.apiKey ? "[unchanged on enter]" : "[blank to use env var]"}: `,
        ),
      )
    ).trim();

    const cfg = buildInitConfig({
      existing: {
        ...existing,
        defaultIngest: defaultIngest || undefined,
        mraWorkspace,
      },
      appTokenTyped: appTokenInput,
      botTokenTyped: botTokenInput,
      apiKeyTyped: apiKeyInput,
    });

    if (
      !presentAndFormatOk(appTokenInput, cfg.slack.appToken, "xapp-") ||
      !presentAndFormatOk(botTokenInput, cfg.slack.botToken, "xoxb-")
    ) {
      println(
        chalk.red(
          "tokens missing or wrong format (must start with xapp-/xoxb-). Aborting.",
        ),
      );
      return;
    }
    const file = saveGatewayConfig(cfg);
    println(chalk.green(`\nsaved → ${file}`));
    println(chalk.dim("Next: `pmk gateway start`"));
  } finally {
    rl.close();
  }
}

export async function startCmd(rest: string[] = []): Promise<void> {
  const dryRun = rest.includes("--dry-run");
  const existing = gatewayRunningPid();
  if (existing) {
    println(
      chalk.yellow(
        `gateway already running (pid ${existing}). Stop it first or run \`pmk gateway status\`.`,
      ),
    );
    process.exit(1);
  }
  try {
    await runGateway({ dryRun });
  } catch (err) {
    println(chalk.red(`[pmk] ${(err as Error).message}`));
    process.exit(1);
  }
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Build a persisted-health status report. Pure and testable — reads only
 * files on disk, never resolves a {cmd}/{env} secret reference.
 *
 * `now` is passed in so tests can control the clock.
 */
export function buildStatusReport(now: number): { level: string; text: string } {
  const run = readGatewayRunStateRaw();
  const pidAlive = run ? isPidAlive(run.pid) : false;
  const hbAt = lastHeartbeatAt();
  const heartbeatAge = hbAt === undefined ? undefined : now - hbAt;
  const v = verdict({ pidAlive, heartbeatAge }); // no live → caps at 🟡
  // NOTE: loadRawGatewayConfig — MUST NEVER resolve a {cmd}/{env} secret here.
  const cfg = loadRawGatewayConfig();
  const events = readGatewayEvents({ sinceMs: now - RECENT_ACTIVITY_WINDOW_MS });
  const turns = events.filter((e) => e.type === "turn.processed").length;
  const lastOffline = [...events].reverse().find(
    (e): e is typeof e & { type: "gateway.offline"; reason: string } =>
      e.type === "gateway.offline",
  );
  const lines = [
    `${v.emoji} ${v.level} — ${v.note}`,
    `  running:    ${pidAlive ? `yes (pid ${run!.pid})` : "no"}`,
    `  supervised: ${run?.supervised ?? "no"}${run?.serviceLabel ? ` (${run.serviceLabel})` : ""}`,
    `  heartbeat:  ${heartbeatAge === undefined ? "none" : `${Math.round(heartbeatAge / 1000)}s ago`}`,
    `  uptime:    ${run && pidAlive ? `${Math.round((now - run.startedAt) / 1000)}s` : "—"}`,
    `  turns/30m: ${turns}`,
    `  last offline reason: ${lastOffline?.reason ?? "—"}`,
    `  mra workspace: ${cfg.mraWorkspace ?? "(not configured)"}`,
    `  live socket: use \`/pmk admin doctor\` in Slack`,
  ];
  return { level: v.level, text: lines.join("\n") };
}

export function statusCmd(): void {
  const r = buildStatusReport(Date.now());
  println(chalk.bold("\npmk gateway status"));
  println(r.text);
}

export function statsCmd(rest: string[]): void {
  const hours = rest[0] ? parseInt(rest[0], 10) : 168; // default 7 days
  const stats = userStats(Number.isFinite(hours) ? hours : 168);
  if (stats.length === 0) {
    println(chalk.yellow(`no activity in last ${hours}h.`));
    return;
  }
  println(chalk.bold(`\nUsage in last ${hours}h (Slack DM only):`));
  println(chalk.dim("  user                  turns   ~tokens   last seen"));
  for (const s of stats) {
    const last = new Date(s.lastActiveAt).toISOString().slice(0, 19);
    const id = (s.displayName ?? s.userId).padEnd(20).slice(0, 20);
    const turns = String(s.turns).padStart(5);
    const tokens = s.approxTokens.toLocaleString().padStart(8);
    println(`  ${id}  ${turns}   ${tokens}   ${last}`);
  }
}

// ---------------------------------------------------------------------------
// pmk gateway stop
// ---------------------------------------------------------------------------

/** Gateway SIGTERM drain budget is 25 s; ~5 s margin. */
const STOP_POLL_MAX = 30;

function requireUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("launchd commands require macOS");
  return uid;
}

/** Poll until the pid is gone (signal-0), up to STOP_POLL_MAX seconds. Returns true if it exited. */
async function awaitProcessExit(pid: number, d: OpsDeps): Promise<boolean> {
  for (let i = 0; i < STOP_POLL_MAX; i++) {
    await d.sleep(1000);
    try { d.kill(pid, 0); } catch { return true; }
  }
  return false;
}

export interface OpsDeps {
  /** Spawn a file synchronously; throws on non-zero exit. */
  execFile: (file: string, args: string[]) => void;
  /** Send a signal to a pid; throw if the pid does not exist (signal 0). */
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep: (ms: number) => Promise<void>;
  /**
   * True when the launchd service label is currently loaded. Injected because
   * the real probe shells out to `launchctl print` against the live gui domain,
   * which ignores $HOME — so without injection a test cannot isolate from a
   * service actually installed on the developer's machine.
   */
  loaded: (label: string) => boolean;
}

const realDeps: OpsDeps = {
  execFile: (f, a) => { execFileSync(f, a, { stdio: "ignore" }); },
  kill: (p, s) => process.kill(p, s),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  loaded: loadedService,
};

/**
 * Decide if the gateway is (or was) managed by launchd and return the
 * service label to target with `launchctl bootout`, plus whether the
 * service is currently loaded (i.e. bootout is valid to issue).
 *
 * Priority:
 *   1. The live run-state says `supervised: "launchd"` with a valid label
 *      → treat as loaded (the process is running under launchd).
 *   2. The service is currently loaded (launchctl print succeeds).
 *   3. A plist file is installed on disk (booted-out but persisted)
 *      → loaded: false; caller must NOT issue bootout.
 */
function launchctlTarget(d: OpsDeps): { label: string; loaded: boolean } | undefined {
  const live = gatewayLiveRunState();
  if (live?.supervised === "launchd" && live.serviceLabel && serviceLabelValid(live.serviceLabel)) {
    return { label: live.serviceLabel, loaded: true };
  }
  if (d.loaded(SERVICE_LABEL)) return { label: SERVICE_LABEL, loaded: true };
  if (installedPlist(SERVICE_LABEL)) return { label: SERVICE_LABEL, loaded: false };
  return undefined;
}

/**
 * Core stop logic — injectable deps make launchctl/kill testable.
 *
 * Decision tree:
 *   a) launchd-managed (running supervised OR service is loaded) → `launchctl bootout`
 *   b) no run-state at all → "not running" message, no side effects
 *   c) standalone process → SIGTERM + 30-poll to confirm exit
 */
export async function stopCmdImpl(d: OpsDeps = realDeps): Promise<string> {
  const live = gatewayLiveRunState();
  const lc = launchctlTarget(d);

  // launchd path: only issue bootout when the service is actually loaded.
  // A plist that exists but is already booted-out doesn't need (or
  // tolerate) a second bootout — lc.loaded handles that distinction.
  if (lc?.loaded) {
    try {
      d.execFile("launchctl", ["bootout", `gui/${requireUid()}/${lc.label}`]);
    } catch {
      return `failed to bootout ${lc.label} — it may already be stopped.`;
    }
    return `stopped launchd service ${lc.label}`;
  }

  if (!live) return "gateway is not running.";

  // Standalone process path
  d.kill(live.pid, "SIGTERM");
  return (await awaitProcessExit(live.pid, d)) ? "gateway stopped (graceful)." : "gateway still running after 30s — check ~/.pmk/logs/gateway.err.log";
}

export async function stopCmd(): Promise<void> {
  println(await stopCmdImpl());
}

// ---------------------------------------------------------------------------
// pmk gateway restart
// ---------------------------------------------------------------------------

export interface RestartDeps extends OpsDeps {
  /** Spawns `gateway start` detached; returns the child pid. */
  spawnDetached: () => number;
  /** Reads run-state raw from disk (may be undefined or stale). */
  readReady: () => { pid: number; phase: string } | undefined;
}

/** Max polls (~1 s each) waiting for the new daemon to reach phase:"ready". */
const STANDALONE_READY_POLL_MAX = 15;

/**
 * Core restart logic — injectable deps make launchctl/spawn testable.
 *
 * Decision tree:
 *   a) Service is currently LOADED in launchd (or supervised live process)
 *      → `launchctl kickstart -k` (terminates the old unit and starts fresh)
 *   b) Plist is INSTALLED but NOT loaded (e.g. after a `stop`/bootout)
 *      → `launchctl bootstrap` (RunAtLoad will start it); kickstart would fail here
 *   c) Standalone (no plist, no loaded service)
 *      → SIGTERM the live process + detached respawn + poll for phase:"ready"
 *        Only phase:"ready" confirms Slack is connected; pid/heartbeat are
 *        written early during "starting" and must not be mistaken for success.
 */
export async function restartCmdImpl(d: RestartDeps): Promise<string> {
  const live = gatewayLiveRunState();
  const installed = installedPlist(SERVICE_LABEL);
  const uid = requireUid();

  if (d.loaded(SERVICE_LABEL) || live?.supervised === "launchd") {
    const kickLabel = (live?.serviceLabel && serviceLabelValid(live.serviceLabel)) ? live.serviceLabel : SERVICE_LABEL;
    d.execFile("launchctl", ["kickstart", "-k", `gui/${uid}/${kickLabel}`]);
    return `restarted launchd service ${kickLabel}`;
  }

  if (installed) {
    // Plist exists but is not loaded — bootstrap brings it into the launchd
    // domain and RunAtLoad starts the process. `kickstart` on an unloaded
    // service would error.
    d.execFile("launchctl", ["bootstrap", `gui/${uid}`, installed.plistPath]);
    return `bootstrapped launchd service ${SERVICE_LABEL}`;
  }

  // Standalone path: stop the live process (if any), then respawn detached
  // and wait for the new daemon to write phase:"ready" to run-state.
  if (live) {
    try { d.kill(live.pid, "SIGTERM"); } catch { /* already gone */ }
    await awaitProcessExit(live.pid, d);
  }

  const childPid = d.spawnDetached();
  for (let i = 0; i < STANDALONE_READY_POLL_MAX; i++) {
    await d.sleep(1000);
    const r = d.readReady();
    if (r && r.pid === childPid && r.phase === "ready") {
      return `gateway restarted (pid ${childPid}).`;
    }
  }
  return "start may have failed — see ~/.pmk/logs/gateway.err.log";
}

export async function restartCmd(): Promise<void> {
  const logsDir = path.join(gatewayDir(), "..", "logs"); // ~/.pmk/logs
  fs.mkdirSync(logsDir, { recursive: true });

  const deps: RestartDeps = {
    ...realDeps,
    readReady: readGatewayRunStateRaw,
    spawnDetached: () => {
      const out = fs.openSync(path.join(logsDir, "gateway.out.log"), "a");
      const err = fs.openSync(path.join(logsDir, "gateway.err.log"), "a");
      const child = spawn(
        process.execPath,
        [path.resolve(__dirname, "../../index.js"), "gateway", "start"],
        { detached: true, stdio: ["ignore", out, err] },
      );
      child.unref();
      fs.closeSync(out);
      fs.closeSync(err);
      return child.pid ?? -1;
    },
  };
  println(await restartCmdImpl(deps));
}
