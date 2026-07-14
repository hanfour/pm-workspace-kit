/**
 * Shared primitives for the `/pmk admin <subcommand>` handlers: the request /
 * result types, the admin-audit log helper, and the Slack-mention parsers.
 * Extracted so per-domain handler modules (admin-review, admin-audience, …) can
 * import them without a cycle through admin.ts (the dispatcher).
 */
import { appendAdminLog } from "../admin-log";
import type { ConnState } from "../socket-health";

/** Live snapshot injected by the SlackAdapter via a provider closure. */
export interface RuntimeHealthSnapshot {
  socket?: { state: ConnState; pongTimeoutsInWindow: number; unstableMs: number };
  watchdog?: { flaps: number; confirmedFailures: number };
  startedAt: number;
}

export interface AdminSlashArgs {
  /** Slack user ID of the admin running the command. */
  actor: string;
  /** Tokens after `admin ` — e.g. ["audience", "set", "<@U0X>", "pm"]. */
  tokens: string[];
  /**
   * Provider function read at COMMAND time (not captured at construction).
   * Injected by SlashCommandHandler when operating inside the live daemon.
   * Absent in CLI-only contexts (e.g., `pmk gateway status`).
   */
  getRuntimeHealthSnapshot?: () => RuntimeHealthSnapshot;
}

export interface AdminSlashResult {
  text: string;
}

export function logAdmin(
  actor: string,
  action: string,
  ok: boolean,
  args?: string,
  reason?: string,
): void {
  appendAdminLog({ actor, origin: "slack", action, args, ok, reason });
}

/**
 * Slack delivers user mentions in slash-command text as `<@U0XYZ>`
 * or `<@U0XYZ|name>`. Accept both that form and a bare `U0XYZ` so
 * admins can type either. Returns undefined on garbage input.
 */
export function extractUserId(token: string): string | undefined {
  if (!token) return undefined;
  const mention = /^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/.exec(token);
  if (mention) return mention[1];
  if (/^[UW][A-Z0-9]{2,}$/.test(token)) return token;
  return undefined;
}

/**
 * Slack channel IDs (#23): `C` (public), `G` (private), or `D` (DM).
 * Slack delivers channel references in slash-command text as
 * `<#C0XYZ|name>` or `<#C0XYZ>`; admins can also paste the raw ID.
 */
export function extractChannelId(token: string): string | undefined {
  if (!token) return undefined;
  const mention = /^<#([CGD][A-Z0-9]+)(?:\|[^>]*)?>$/.exec(token);
  if (mention) return mention[1];
  if (/^[CGD][A-Z0-9]{2,}$/.test(token)) return token;
  return undefined;
}
