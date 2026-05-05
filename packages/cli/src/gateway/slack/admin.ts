/**
 * `/pmk admin <subcommand>` Slack handler (v0.9.0 / #31).
 *
 * Lets a configured admin run gateway-config mutations from Slack
 * without needing terminal access to the host. Permission gate +
 * routing live in `slack/index.ts`'s handleSlashCommand; this module
 * is the per-subcommand business logic.
 *
 * Trust model:
 *   - Caller must be in `cfg.admins` (checked before this is invoked)
 *   - DM-only (checked before this is invoked)
 *   - First admin is bootstrapped via host CLI; you cannot grant
 *     yourself admin from Slack
 *   - Last-admin protection: cannot remove the only admin, even from
 *     Slack
 *
 * NOT exposed via Slack (deliberately):
 *   - `init` (would echo Slack tokens in plaintext)
 *   - Token rotation
 *   - Atom edit body (security — pasted content goes verbatim into
 *     retrieval; CLI's $EDITOR-with-validation is safer)
 *   - Process stop/restart
 *   - Blocklist mutation (until tier-2 admin model exists)
 *
 * Replies are returned as plain Slack mrkdwn strings; the calling
 * SlackAdapter handles the actual `chat.postMessage`.
 */

import {
  AUDIENCE_KEYS,
  type AudienceKey,
} from "@pmk/shared";
import {
  isAdmin,
  loadGatewayConfig,
  saveGatewayConfig,
  type GatewayConfig,
} from "../config";
import {
  approveAtom,
  findAtomByPrefix,
  loadAtoms,
  rejectAtom,
} from "../knowledge";
import { appendAdminLog, readAdminLog } from "../admin-log";

export interface AdminSlashArgs {
  /** Slack user ID of the admin running the command. */
  actor: string;
  /** Tokens after `admin ` — e.g. ["audience", "set", "<@U0X>", "pm"]. */
  tokens: string[];
}

export interface AdminSlashResult {
  text: string;
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

const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{2,}$/;

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

function logAdmin(
  actor: string,
  action: string,
  ok: boolean,
  args?: string,
  reason?: string,
): void {
  appendAdminLog({ actor, origin: "slack", action, args, ok, reason });
}

/**
 * Top-level dispatch. Returns the Slack-mrkdwn reply text; caller
 * posts it. Permission + DM-only gating happen upstream.
 */
export async function handleAdminSlash(
  args: AdminSlashArgs,
): Promise<AdminSlashResult> {
  const [head, ...rest] = args.tokens;
  switch (head) {
    case undefined:
    case "help":
      return { text: helpText() };
    case "status":
      return adminStatus(args.actor);
    case "audience":
      return adminAudience(args.actor, rest);
    case "escalation":
      return adminEscalation(args.actor, rest);
    case "atoms":
      return adminAtoms(args.actor, rest);
    case "admins":
      return adminAdmins(args.actor, rest);
    case "audit":
      return adminAudit(args.actor, rest);
    default:
      return {
        text: `:question: 未知的 admin 子指令 \`${head}\`。\n${helpText()}`,
      };
  }
}

function helpText(): string {
  return [
    "*pmk admin commands* (DM-only, admin-restricted)",
    "• `/pmk admin status` — gateway status",
    "• `/pmk admin audience set @user <tech|pm|biz|exec>`",
    "• `/pmk admin audience set-channel #channel <tech|pm|biz|exec>` (#23)",
    "• `/pmk admin audience default <tech|pm|biz|exec>`",
    "• `/pmk admin escalation add <repo|default> @user`",
    "• `/pmk admin escalation remove <repo|default> @user`",
    "• `/pmk admin atoms list [pending|approved|all]`",
    "• `/pmk admin atoms show <id-prefix>`",
    "• `/pmk admin atoms approve <id-prefix>`",
    "• `/pmk admin atoms reject <id-prefix>`",
    "• `/pmk admin admins list`",
    "• `/pmk admin admins add @user`",
    "• `/pmk admin admins remove @user`",
    "• `/pmk admin audit [N]` — last N admin actions (default 20)",
  ].join("\n");
}

// ────────────────── status ──────────────────

function adminStatus(actor: string): AdminSlashResult {
  const cfg = loadGatewayConfig();
  const lines: string[] = ["*gateway status*"];
  lines.push(`• mra workspace: ${cfg.mraWorkspace ?? "_(not configured)_"}`);
  lines.push(
    `• default ingest: ${cfg.defaultIngest ?? "_(none)_"}`,
  );
  lines.push(`• audience default: \`${cfg.audience.default}\``);
  lines.push(`• admins: ${cfg.admins.length}`);
  lines.push(
    `• escalation default pool: ${cfg.escalation.default.length ? cfg.escalation.default.join(", ") : "_(empty)_"}`,
  );
  const repoCount = Object.keys(cfg.escalation.repos).length;
  lines.push(`• escalation repo pools: ${repoCount}`);
  logAdmin(actor, "status", true);
  return { text: lines.join("\n") };
}

// ────────────────── audience ──────────────────

function isAudienceKey(s: string): s is AudienceKey {
  return (AUDIENCE_KEYS as readonly string[]).includes(s);
}

function adminAudience(
  actor: string,
  tokens: string[],
): AdminSlashResult {
  const [sub, ...args] = tokens;
  const cfg = loadGatewayConfig();
  switch (sub) {
    case "set": {
      const [userToken, key] = args;
      const userId = extractUserId(userToken);
      if (!userId || !key) {
        logAdmin(actor, "audience.set", false, undefined, "missing args");
        return { text: ":x: usage: `/pmk admin audience set @user <tech|pm|biz|exec>`" };
      }
      if (!isAudienceKey(key)) {
        logAdmin(actor, "audience.set", false, `${userId} ${key}`, "invalid audience");
        return { text: `:x: invalid audience \`${key}\` — must be tech, pm, biz, or exec` };
      }
      cfg.audience.users[userId] = key;
      saveGatewayConfig(cfg);
      logAdmin(actor, "audience.set", true, `${userId} ${key}`);
      return { text: `:white_check_mark: <@${userId}> audience set to \`${key}\`` };
    }
    case "unset": {
      const userId = extractUserId(args[0]);
      if (!userId) {
        logAdmin(actor, "audience.unset", false, undefined, "missing args");
        return { text: ":x: usage: `/pmk admin audience unset @user`" };
      }
      if (!(userId in cfg.audience.users)) {
        logAdmin(actor, "audience.unset", true, userId, "no override");
        return { text: `(${userId} has no override; nothing to do)` };
      }
      delete cfg.audience.users[userId];
      saveGatewayConfig(cfg);
      logAdmin(actor, "audience.unset", true, userId);
      return { text: `:white_check_mark: <@${userId}> override removed (falls back to default \`${cfg.audience.default}\`)` };
    }
    case "default": {
      const [key] = args;
      if (!key || !isAudienceKey(key)) {
        logAdmin(actor, "audience.default", false, key, "invalid audience");
        return { text: ":x: usage: `/pmk admin audience default <tech|pm|biz|exec>`" };
      }
      cfg.audience.default = key;
      saveGatewayConfig(cfg);
      logAdmin(actor, "audience.default", true, key);
      return { text: `:white_check_mark: default audience set to \`${key}\`` };
    }
    case "set-channel": {
      const [channelToken, key] = args;
      const channelId = extractChannelId(channelToken);
      if (!channelId || !key) {
        logAdmin(actor, "audience.set-channel", false, undefined, "missing args");
        return { text: ":x: usage: `/pmk admin audience set-channel #channel <tech|pm|biz|exec>`" };
      }
      if (!isAudienceKey(key)) {
        logAdmin(actor, "audience.set-channel", false, `${channelId} ${key}`, "invalid audience");
        return { text: `:x: invalid audience \`${key}\` — must be tech, pm, biz, or exec` };
      }
      cfg.audience.channels[channelId] = key;
      saveGatewayConfig(cfg);
      logAdmin(actor, "audience.set-channel", true, `${channelId} ${key}`);
      return { text: `:white_check_mark: <#${channelId}> default audience set to \`${key}\`` };
    }
    case "unset-channel": {
      const channelId = extractChannelId(args[0]);
      if (!channelId) {
        logAdmin(actor, "audience.unset-channel", false, undefined, "missing args");
        return { text: ":x: usage: `/pmk admin audience unset-channel #channel`" };
      }
      if (!(channelId in cfg.audience.channels)) {
        logAdmin(actor, "audience.unset-channel", true, channelId, "no override");
        return { text: `(<#${channelId}> has no override; nothing to do)` };
      }
      delete cfg.audience.channels[channelId];
      saveGatewayConfig(cfg);
      logAdmin(actor, "audience.unset-channel", true, channelId);
      return { text: `:white_check_mark: <#${channelId}> override removed (falls back to workspace default \`${cfg.audience.default}\`)` };
    }
    case "list":
    case undefined: {
      const lines: string[] = ["*audience config*"];
      lines.push(`• default: \`${cfg.audience.default}\``);
      const userEntries = Object.entries(cfg.audience.users);
      if (userEntries.length === 0) {
        lines.push("• per-user overrides: _(none)_");
      } else {
        lines.push("• per-user overrides:");
        for (const [uid, aud] of userEntries) {
          lines.push(`  - <@${uid}> → \`${aud}\``);
        }
      }
      const channelEntries = Object.entries(cfg.audience.channels);
      if (channelEntries.length === 0) {
        lines.push("• per-channel overrides: _(none)_");
      } else {
        lines.push("• per-channel overrides:");
        for (const [cid, aud] of channelEntries) {
          lines.push(`  - <#${cid}> → \`${aud}\``);
        }
      }
      lines.push(
        "• resolution order at turn time: per-user → per-channel → default",
      );
      return { text: lines.join("\n") };
    }
    default:
      return { text: ":x: usage: `/pmk admin audience set|unset|set-channel|unset-channel|default|list`" };
  }
}

// ────────────────── escalation ──────────────────

function adminEscalation(
  actor: string,
  tokens: string[],
): AdminSlashResult {
  const [sub, scopeRaw, userToken] = tokens;
  const cfg = loadGatewayConfig();
  switch (sub) {
    case "add":
    case "remove": {
      if (!scopeRaw || !userToken) {
        return {
          text: `:x: usage: \`/pmk admin escalation ${sub} <repo|default> @user\``,
        };
      }
      const userId = extractUserId(userToken);
      if (!userId) {
        logAdmin(actor, `escalation.${sub}`, false, userToken, "invalid Slack user ID");
        return { text: `:x: invalid Slack user ID \`${userToken}\`` };
      }
      // Reject path-traversal-style strings; align with safeScope rules.
      const scope = scopeRaw === "default" ? null : scopeRaw.replace(/[^a-zA-Z0-9_-]/g, "");
      if (scope !== null && !scope) {
        return { text: `:x: invalid scope \`${scopeRaw}\`` };
      }
      const pool =
        scope === null
          ? cfg.escalation.default
          : (cfg.escalation.repos[scope] ??= []);
      if (sub === "add") {
        if (!pool.includes(userId)) pool.push(userId);
        saveGatewayConfig(cfg);
        logAdmin(actor, "escalation.add", true, `${scope ?? "default"} ${userId}`);
        return {
          text: `:white_check_mark: added <@${userId}> to ${scope ? `\`${scope}\`` : "default"} pool`,
        };
      }
      const idx = pool.indexOf(userId);
      if (idx < 0) {
        logAdmin(actor, "escalation.remove", true, `${scope ?? "default"} ${userId}`, "not in pool");
        return {
          text: `(<@${userId}> not in ${scope ? `\`${scope}\`` : "default"} pool; nothing to do)`,
        };
      }
      pool.splice(idx, 1);
      saveGatewayConfig(cfg);
      logAdmin(actor, "escalation.remove", true, `${scope ?? "default"} ${userId}`);
      return {
        text: `:white_check_mark: removed <@${userId}> from ${scope ? `\`${scope}\`` : "default"} pool`,
      };
    }
    case "list":
    case undefined: {
      const lines: string[] = ["*escalation config*"];
      lines.push(
        `• default: ${cfg.escalation.default.length ? cfg.escalation.default.map((u) => `<@${u}>`).join(", ") : "_(empty)_"}`,
      );
      const repoEntries = Object.entries(cfg.escalation.repos);
      if (repoEntries.length === 0) {
        lines.push("• repo pools: _(none)_");
      } else {
        lines.push("• repo pools:");
        for (const [repo, ids] of repoEntries) {
          lines.push(`  - \`${repo}\`: ${ids.length ? ids.map((u) => `<@${u}>`).join(", ") : "_(empty)_"}`);
        }
      }
      return { text: lines.join("\n") };
    }
    default:
      return { text: ":x: usage: `/pmk admin escalation add|remove|list`" };
  }
}

// ────────────────── atoms ──────────────────

function adminAtoms(actor: string, tokens: string[]): AdminSlashResult {
  const [sub, ...args] = tokens;
  switch (sub) {
    case "list":
    case undefined: {
      const filterArg = args[0];
      const filter =
        filterArg === "pending" || filterArg === "approved" ? filterArg : "all";
      const atoms = loadAtoms().filter((a) =>
        filter === "all" ? true : a.status === filter,
      );
      if (atoms.length === 0) {
        return { text: `*atoms (${filter})*: _(none)_` };
      }
      const lines: string[] = [`*atoms (${filter})* — ${atoms.length} total`];
      for (const a of atoms.slice(0, 20)) {
        const status = a.status === "pending" ? "⏳" : "✅";
        const idShort = a.id.split("-").slice(0, 2).join("-");
        lines.push(`${status} \`${idShort}\`  ${a.scope}  ${a.question.slice(0, 70)}`);
      }
      if (atoms.length > 20) {
        lines.push(`_(showing first 20 of ${atoms.length})_`);
      }
      return { text: lines.join("\n") };
    }
    case "show": {
      const [idOrPrefix] = args;
      if (!idOrPrefix) {
        return { text: ":x: usage: `/pmk admin atoms show <id-prefix>`" };
      }
      const found = findAtomByPrefix(idOrPrefix);
      if (!found) {
        return { text: `:x: no unique match for \`${idOrPrefix}\`` };
      }
      const a = found.atom;
      return {
        text: [
          `*${a.question}*`,
          `• id: \`${a.id}\``,
          `• scope: \`${a.scope}\``,
          `• status: \`${a.status}\``,
          a.expiresAt
            ? `• expires: in ${Math.max(0, Math.floor((a.expiresAt - Date.now()) / 60_000))}m`
            : null,
          `• tags: ${a.tags.join(", ") || "—"}`,
          `• contributor: <@${a.source.contributorUserId}>`,
          "",
          a.summary ? `*Summary*\n${a.summary}` : null,
          "",
          `*Answer*\n${a.answer}`,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    case "approve": {
      const [idOrPrefix] = args;
      if (!idOrPrefix) {
        return { text: ":x: usage: `/pmk admin atoms approve <id-prefix>`" };
      }
      const promoted = approveAtom(idOrPrefix);
      if (!promoted) {
        logAdmin(actor, "atoms.approve", false, idOrPrefix, "no unique match");
        return { text: `:x: no unique match for \`${idOrPrefix}\`` };
      }
      logAdmin(actor, "atoms.approve", true, promoted.id);
      return { text: `:books: approved \`${promoted.id}\`` };
    }
    case "reject": {
      const [idOrPrefix] = args;
      if (!idOrPrefix) {
        return { text: ":x: usage: `/pmk admin atoms reject <id-prefix>`" };
      }
      const found = findAtomByPrefix(idOrPrefix);
      if (!found) {
        logAdmin(actor, "atoms.reject", false, idOrPrefix, "no unique match");
        return { text: `:x: no unique match for \`${idOrPrefix}\`` };
      }
      const ok = rejectAtom(idOrPrefix);
      logAdmin(actor, "atoms.reject", ok, found.atom.id);
      return ok
        ? { text: `:wastebasket: rejected (deleted) \`${found.atom.id}\`` }
        : { text: `:x: failed to delete atom file` };
    }
    default:
      return {
        text: ":x: usage: `/pmk admin atoms list|show|approve|reject`",
      };
  }
}

// ────────────────── admins ──────────────────

function adminAdmins(actor: string, tokens: string[]): AdminSlashResult {
  const [sub, userToken] = tokens;
  const cfg = loadGatewayConfig();
  switch (sub) {
    case "list":
    case undefined: {
      if (cfg.admins.length === 0) {
        return { text: "*admins*: _(none — bootstrap via host CLI)_" };
      }
      return {
        text: ["*admins*", ...cfg.admins.map((id) => `• <@${id}>`)].join("\n"),
      };
    }
    case "add": {
      const userId = extractUserId(userToken);
      if (!userId) {
        return { text: ":x: usage: `/pmk admin admins add @user`" };
      }
      if (!SLACK_USER_ID_RE.test(userId)) {
        logAdmin(actor, "admins.add", false, userId, "invalid Slack user ID");
        return { text: `:x: invalid Slack user ID \`${userId}\`` };
      }
      if (cfg.admins.includes(userId)) {
        return { text: `(<@${userId}> is already an admin; nothing to do)` };
      }
      cfg.admins.push(userId);
      saveGatewayConfig(cfg);
      logAdmin(actor, "admins.add", true, userId);
      return { text: `:white_check_mark: <@${userId}> added to admins` };
    }
    case "remove": {
      const userId = extractUserId(userToken);
      if (!userId) {
        return { text: ":x: usage: `/pmk admin admins remove @user`" };
      }
      if (!cfg.admins.includes(userId)) {
        return { text: `(<@${userId}> is not an admin; nothing to do)` };
      }
      // Last-admin protection — even from Slack you can't lock everyone
      // out. Self-removal of the only admin would also lock the host
      // out of the Slack admin path entirely.
      if (cfg.admins.length === 1) {
        logAdmin(actor, "admins.remove", false, userId, "last-admin protection");
        return {
          text: `:no_entry_sign: cannot remove last admin <@${userId}>. Add a replacement first.`,
        };
      }
      cfg.admins = cfg.admins.filter((id) => id !== userId);
      saveGatewayConfig(cfg);
      logAdmin(actor, "admins.remove", true, userId);
      return { text: `:white_check_mark: <@${userId}> removed from admins` };
    }
    default:
      return { text: ":x: usage: `/pmk admin admins list|add|remove`" };
  }
}

// ────────────────── audit ──────────────────

function adminAudit(_actor: string, tokens: string[]): AdminSlashResult {
  const nArg = tokens[0] ? Number.parseInt(tokens[0], 10) : NaN;
  const n = Number.isFinite(nArg) && nArg > 0 ? nArg : 20;
  const entries = readAdminLog(n);
  if (entries.length === 0) {
    return { text: "*admin audit*: _(no entries yet)_" };
  }
  const lines: string[] = [`*admin audit (last ${entries.length})*`];
  for (const e of entries) {
    const at = (e as { at?: string }).at?.slice(11, 19) ?? "??:??:??";
    const ok = e.ok ? "✅" : "❌";
    const tail = e.args ? `  ${e.args}` : "";
    const reason = !e.ok && e.reason ? ` _(${e.reason})_` : "";
    lines.push(
      `\`${at}\`  ${ok}  ${e.origin}  ${e.actor}  \`${e.action}\`${tail}${reason}`,
    );
  }
  return { text: lines.join("\n") };
}

// Export for tests.
export const _internals = {
  isAdmin,
  loadGatewayConfig,
  saveGatewayConfig,
  type: {} as GatewayConfig,
};
