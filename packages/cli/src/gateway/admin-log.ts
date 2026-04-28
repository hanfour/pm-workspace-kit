/**
 * Append-only audit log for admin actions (v0.9 / #31).
 *
 * Every admin mutation — both via the host CLI (`pmk gateway admin
 * add/remove`, `audience set`, etc.) and via Slack (`/pmk admin ...`)
 * — appends a JSONL line to `~/.pmk/gateway/admin.log`. This lets
 * the host trace who-did-what-when after the fact, especially when
 * multiple admins are configured.
 *
 * Format is one JSON object per line:
 *
 *   {"at":"2026-04-28T...","actor":"U0HANFOUR","origin":"slack",
 *    "action":"audience.set","args":"U0XYZ pm","ok":true}
 *
 * The `actor` is whoever performed the action — for CLI it's
 * "cli:<unix_user>" since pmk doesn't authenticate the OS user; for
 * Slack it's the Slack user ID. `origin` distinguishes the two so
 * audits can be filtered.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gatewayDir } from "./config";

export interface AdminLogEntry {
  /** Slack user ID for "slack" origin; "cli:<unix_user>" for "cli". */
  actor: string;
  origin: "cli" | "slack";
  /** Dotted action key, e.g. `audience.set`, `escalation.add`,
   *  `atoms.approve`, `admins.remove`. */
  action: string;
  /** Free-form args for context (target user, repo, atom id, etc.). */
  args?: string;
  /** Did the action complete? false for permission denied / validation
   * failure / last-admin protection / not-found. */
  ok: boolean;
  /** Optional reason when ok=false (helps post-incident triage). */
  reason?: string;
}

export function adminLogPath(): string {
  return path.join(gatewayDir(), "admin.log");
}

/**
 * Append a structured admin action to the log. Best-effort — failures
 * to write the log don't block the action itself, since blocking on
 * audit-log corruption would be worse than the missing log line.
 */
export function appendAdminLog(entry: AdminLogEntry): void {
  try {
    fs.mkdirSync(gatewayDir(), { recursive: true });
    const line =
      JSON.stringify({
        at: new Date().toISOString(),
        ...entry,
      }) + "\n";
    fs.appendFileSync(adminLogPath(), line, "utf8");
  } catch {
    /* non-fatal */
  }
}

/**
 * Convenience: build the actor string for a CLI invocation. The
 * unix user isn't an authentication boundary (anyone with shell
 * access already had keys to the kingdom) but it's useful in the
 * audit log to distinguish operators on shared hosts.
 */
export function cliActor(): string {
  try {
    return `cli:${os.userInfo().username}`;
  } catch {
    return "cli:unknown";
  }
}

/**
 * Read the last N entries from the audit log (newest last). Returns
 * empty array on read error or missing file. Used by `/pmk admin
 * audit` and the host CLI counterpart.
 */
export function readAdminLog(limit = 50): AdminLogEntry[] {
  const file = adminLogPath();
  if (!fs.existsSync(file)) return [];
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter((l) => l.length > 0);
  const tail = lines.slice(-limit);
  const out: AdminLogEntry[] = [];
  for (const line of tail) {
    try {
      out.push(JSON.parse(line) as AdminLogEntry);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}
