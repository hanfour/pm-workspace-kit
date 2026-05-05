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

import * as os from "node:os";
import { gatewayDir } from "./config";
import { appendJsonl, monthlyPath, readJsonl } from "./monthly-jsonl";

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

/**
 * Path to the current month's admin partition. Exposed for tests
 * that inject synthetic / malformed lines and for operators tailing
 * the live feed. The returned path moves on UTC month boundaries;
 * callers needing a specific month should compute it via
 * `monthlyPath` directly.
 */
export function adminLogPath(): string {
  return monthlyPath(gatewayDir(), "admin");
}

/**
 * Append a structured admin action to the log. Best-effort — failures
 * to write the log don't block the action itself, since blocking on
 * audit-log corruption would be worse than the missing log line.
 */
export function appendAdminLog(entry: AdminLogEntry): void {
  appendJsonl(gatewayDir(), "admin", entry);
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
  const all = readJsonl(gatewayDir(), "admin", isAdminLogEntry, {});
  if (limit < 0 || all.length <= limit) return all;
  return all.slice(all.length - limit);
}

function isAdminLogEntry(v: unknown): v is AdminLogEntry {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.actor === "string" &&
    (o.origin === "cli" || o.origin === "slack") &&
    typeof o.action === "string" &&
    typeof o.ok === "boolean"
  );
}
