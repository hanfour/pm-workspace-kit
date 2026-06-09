import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { println } from "../../io";
import { loadRawGatewayConfig } from "../../gateway/config";
import type { RawGatewayConfig } from "../../gateway/config";
import { SERVICE_LABEL, installedPlist } from "../../gateway/run-state";

const LAUNCH_AGENTS_DIR = path.join("Library", "LaunchAgents");
const COLLAB_SENTINEL = path.join(".collab", "repos.json");
const PMK_LOGS_DIR = path.join(".pmk", "logs");

/** Escape a string for safe embedding in plist XML string values. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildPlist(o: { nodePath: string; distEntry: string; home: string; workingDir: string }): string {
  const out = path.join(o.home, PMK_LOGS_DIR, "gateway.out.log");
  const err = path.join(o.home, PMK_LOGS_DIR, "gateway.err.log");
  const label = escapeXml(SERVICE_LABEL);
  const nodePath = escapeXml(o.nodePath);
  const distEntry = escapeXml(o.distEntry);
  const workingDir = escapeXml(o.workingDir);
  const home = escapeXml(o.home);
  const outLog = escapeXml(out);
  const errLog = escapeXml(err);
  const pathEnv = escapeXml(process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${nodePath}</string><string>${distEntry}</string><string>gateway</string><string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- Interactive (NOT Background): the gateway holds a Slack Socket-Mode
       connection that must answer pings/pongs within seconds. Background
       process-type opts into App Nap / resource throttling, which starves
       the socket → pong timeouts → endless watchdog reconnects. Interactive
       runs at app-level priority and is never throttled. -->
  <key>ProcessType</key><string>Interactive</string>
  <key>WorkingDirectory</key><string>${workingDir}</string>
  <key>StandardOutPath</key><string>${outLog}</string>
  <key>StandardErrorPath</key><string>${errLog}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PMK_SERVICE</key><string>launchd</string>
    <key>PMK_SERVICE_LABEL</key><string>${label}</string>
    <key>HOME</key><string>${home}</string>
    <key>PATH</key><string>${pathEnv}</string>
  </dict>
</dict></plist>
`;
}

/** Raw secret sources that are {env} won't resolve under launchd's minimal env. */
export function envSecretWarnings(cfg: Pick<RawGatewayConfig, "slack" | "apiKey">): string[] {
  const warns: string[] = [];
  const check = (name: string, v: unknown) => {
    if (v && typeof v === "object" && "env" in (v as object)) {
      warns.push(`${name} is an {env:${(v as { env: string }).env}} reference — the LaunchAgent has no such env; use a {cmd} ref / literal, or add it to the plist yourself.`);
    }
  };
  check("slack.appToken", cfg.slack?.appToken);
  check("slack.botToken", cfg.slack?.botToken);
  check("apiKey", cfg.apiKey);
  return warns;
}

export function installServiceCmd(opts: { load?: boolean; uninstall?: boolean; force?: boolean } = {}): void {
  if (process.platform !== "darwin") { println("install-service is macOS-only (launchd)."); return; }
  const plistPath = path.join(os.homedir(), LAUNCH_AGENTS_DIR, `${SERVICE_LABEL}.plist`);
  const uid = process.getuid?.();
  if (uid === undefined) { println("launchd requires macOS."); return; }
  if (opts.uninstall) {
    try { execFileSync("launchctl", ["bootout", `gui/${uid}/${SERVICE_LABEL}`], { stdio: "ignore" }); } catch { /* not loaded */ }
    try { fs.unlinkSync(plistPath); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    println(`uninstalled ${SERVICE_LABEL}.`); return;
  }
  if (installedPlist() && !opts.force) { println(`${plistPath} already exists. Re-run with --force to overwrite.`); return; }
  const cfg = loadRawGatewayConfig();
  for (const w of envSecretWarnings(cfg)) println(`  ⚠️  ${w}`);
  let workingDir: string;
  if (cfg.mraWorkspace && fs.existsSync(path.join(cfg.mraWorkspace, COLLAB_SENTINEL))) {
    workingDir = cfg.mraWorkspace;
  } else {
    println("  ⚠️  mraWorkspace not set/valid — mra-ask falls back to cwd-walk from the install dir.");
    workingDir = process.cwd();
  }
  const distEntry = path.resolve(__dirname, "../../index.js");
  if (!fs.existsSync(distEntry)) {
    println(`⚠️ resolved gateway entry ${distEntry} does not exist — the LaunchAgent may fail to start; verify your build.`);
  }
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.mkdirSync(path.join(os.homedir(), PMK_LOGS_DIR), { recursive: true });
  fs.writeFileSync(plistPath, buildPlist({ nodePath: process.execPath, distEntry, home: os.homedir(), workingDir }), "utf8");
  println(`wrote ${plistPath}`);
  if (opts.load) {
    try {
      execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { stdio: "pipe" });
      execFileSync("launchctl", ["enable", `gui/${uid}/${SERVICE_LABEL}`], { stdio: "pipe" });
      println("loaded.");
    } catch (e) {
      println(`plist was written to ${plistPath} but could not be loaded: ${(e as Error).message}`);
      println(`Re-run with --force or load manually: launchctl bootstrap gui/${uid} ${plistPath} && launchctl enable gui/${uid}/${SERVICE_LABEL}`);
    }
  } else {
    println(`Next: launchctl bootstrap gui/${uid} ${plistPath} && launchctl enable gui/${uid}/${SERVICE_LABEL}`);
  }
}
