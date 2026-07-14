/**
 * `/pmk admin audience …` handlers — per-user / per-channel / default audience
 * tier overrides (#23) and the v0.15 workspace-specific translation examples.
 * Extracted from admin.ts; dispatched by handleAdminSlash.
 */
import { AUDIENCE_KEYS, type AudienceKey } from "@pmk/shared";
import { loadRawGatewayConfig, saveGatewayConfig } from "../config";
import {
  logAdmin,
  extractUserId,
  extractChannelId,
  type AdminSlashResult,
} from "./admin-shared";

function isAudienceKey(s: string): s is AudienceKey {
  return (AUDIENCE_KEYS as readonly string[]).includes(s);
}

export function adminAudience(
  actor: string,
  tokens: string[],
): AdminSlashResult {
  const [sub, ...args] = tokens;
  const cfg = loadRawGatewayConfig();
  switch (sub) {
    case "set": {
      const [userToken, key] = args;
      const userId = extractUserId(userToken);
      if (!userId || !key) {
        logAdmin(actor, "audience.set", false, undefined, "missing args");
        return { text: ":x: usage: `/pmk admin audience set @user <tech|pm|biz|sales|exec>`" };
      }
      if (!isAudienceKey(key)) {
        logAdmin(actor, "audience.set", false, `${userId} ${key}`, "invalid audience");
        return { text: `:x: invalid audience \`${key}\` — must be tech, pm, biz, sales, or exec` };
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
        return { text: ":x: usage: `/pmk admin audience default <tech|pm|biz|sales|exec>`" };
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
        return { text: ":x: usage: `/pmk admin audience set-channel #channel <tech|pm|biz|sales|exec>`" };
      }
      if (!isAudienceKey(key)) {
        logAdmin(actor, "audience.set-channel", false, `${channelId} ${key}`, "invalid audience");
        return { text: `:x: invalid audience \`${key}\` — must be tech, pm, biz, sales, or exec` };
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
    case "example": {
      return adminAudienceExample(actor, args);
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
      const ex = cfg.audience.domainExamples;
      const bizCount = ex?.biz?.length ?? 0;
      const pmCount = ex?.pm?.length ?? 0;
      lines.push(
        `• workspace examples: biz ${bizCount} · pm ${pmCount} (see \`/pmk admin audience example list\`)`,
      );
      lines.push(
        "• resolution order at turn time: per-user → per-channel → default",
      );
      return { text: lines.join("\n") };
    }
    default:
      return { text: ":x: usage: `/pmk admin audience set|unset|set-channel|unset-channel|default|list|example`" };
  }
}

// ────────────────── audience example (v0.15) ──────────────────

const EXAMPLE_TIERS = ["biz", "pm"] as const;
type ExampleTier = (typeof EXAMPLE_TIERS)[number];
function isExampleTier(t: string | undefined): t is ExampleTier {
  return !!t && (EXAMPLE_TIERS as readonly string[]).includes(t);
}

/**
 * v0.15.0: workspace-specific translation rows operators can register
 * to extend the BIZ / PM cheat-sheet without forking the shared
 * package. Mutations require a graceful gateway restart to bite (same
 * in-memory snapshot caveat as the rest of `audience`).
 *
 * Slack tokenisation:
 *   `/pmk admin audience example add biz AdFormat = 廣告版型`
 *           → tokens = ["example", "add", "biz", "AdFormat", "=", "廣告版型"]
 * The `=` separator is required so multi-word target forms (with
 * spaces) survive the whitespace split.
 */
function adminAudienceExample(
  actor: string,
  args: string[],
): AdminSlashResult {
  const cfg = loadRawGatewayConfig();
  if (!cfg.audience.domainExamples) cfg.audience.domainExamples = {};
  if (!cfg.audience.domainExamples.biz) cfg.audience.domainExamples.biz = [];
  if (!cfg.audience.domainExamples.pm) cfg.audience.domainExamples.pm = [];
  const examples = cfg.audience.domainExamples;
  const [sub, ...rest] = args;
  switch (sub) {
    case "add": {
      const [tier, techForm, sep, ...targetParts] = rest;
      if (
        !isExampleTier(tier) ||
        !techForm ||
        sep !== "=" ||
        targetParts.length === 0
      ) {
        logAdmin(actor, "audience.example.add", false, args.join(" "), "bad args");
        return {
          text: ":x: usage: `/pmk admin audience example add <biz|pm> <techForm> = <targetForm>`",
        };
      }
      const targetForm = targetParts.join(" ").trim();
      const list = examples[tier]!;
      const existing = list.findIndex((e) => e.techForm === techForm);
      const action = existing >= 0 ? "updated" : "added";
      if (existing >= 0) list[existing] = { techForm, targetForm };
      else list.push({ techForm, targetForm });
      saveGatewayConfig(cfg);
      logAdmin(actor, "audience.example.add", true, `${tier} ${techForm} = ${targetForm}`);
      return {
        text: `:white_check_mark: ${action} ${tier} example: \`${techForm}\` → ${targetForm}  _(restart gateway to apply)_`,
      };
    }
    case "remove": {
      const [tier, techForm] = rest;
      if (!isExampleTier(tier) || !techForm) {
        logAdmin(actor, "audience.example.remove", false, rest.join(" "), "bad args");
        return {
          text: ":x: usage: `/pmk admin audience example remove <biz|pm> <techForm>`",
        };
      }
      const list = examples[tier]!;
      const idx = list.findIndex((e) => e.techForm === techForm);
      if (idx < 0) {
        logAdmin(actor, "audience.example.remove", true, `${tier} ${techForm}`, "not found");
        return { text: `(${tier} has no example for \`${techForm}\`; nothing to do)` };
      }
      list.splice(idx, 1);
      saveGatewayConfig(cfg);
      logAdmin(actor, "audience.example.remove", true, `${tier} ${techForm}`);
      return {
        text: `:white_check_mark: removed ${tier} example: \`${techForm}\`  _(restart gateway to apply)_`,
      };
    }
    case "list":
    case undefined: {
      const filter = rest[0];
      const tiers: ExampleTier[] = isExampleTier(filter)
        ? [filter]
        : ["biz", "pm"];
      const lines: string[] = ["*audience examples* (workspace-specific cheat-sheet additions)"];
      for (const tier of tiers) {
        const rows = examples[tier] ?? [];
        if (rows.length === 0) {
          lines.push(`• ${tier}: _(none)_`);
        } else {
          lines.push(`• ${tier}:`);
          for (const row of rows) {
            lines.push(`  - \`${row.techForm}\` → ${row.targetForm}`);
          }
        }
      }
      lines.push(
        "_applied at prompt-assembly time; gateway restart required for changes to take effect._",
      );
      return { text: lines.join("\n") };
    }
    default:
      return {
        text: ":x: usage: `/pmk admin audience example add|remove|list ...`",
      };
  }
}
