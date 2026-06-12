import chalk from "chalk";
import { println } from "../../io";
import { loadRawGatewayConfig, saveGatewayConfig } from "../../gateway/config";
import {
  ensureValidSlackChannelId,
  ensureValidSlackUserId,
  isAudienceKey,
  isExampleTier,
  type ExampleTier,
} from "./shared";
import type { AudienceKey } from "@pmk/shared";

export function audienceUsage(): void {
  println(
    chalk.yellow(
      "usage:\n" +
        "  pmk gateway audience list\n" +
        "  pmk gateway audience set <userId> <tech|pm|biz|sales|exec>\n" +
        "  pmk gateway audience unset <userId>\n" +
        "  pmk gateway audience set-channel <channelId> <tech|pm|biz|sales|exec>\n" +
        "  pmk gateway audience unset-channel <channelId>\n" +
        "  pmk gateway audience default <tech|pm|biz|sales|exec>\n" +
        "  pmk gateway audience example list [biz|pm]\n" +
        "  pmk gateway audience example add <biz|pm> <techForm> <targetForm...>\n" +
        "  pmk gateway audience example remove <biz|pm> <techForm>",
    ),
  );
}

/** Test-only seam: persist a per-user audience override via the same raw
 * load/save path the real handler uses (proves references aren't materialised). */
export function _audienceSetForTest(userId: string, key: AudienceKey): void {
  const cfg = loadRawGatewayConfig();
  saveGatewayConfig({
    ...cfg,
    audience: {
      ...cfg.audience,
      users: { ...cfg.audience.users, [userId]: key },
    },
  });
}

export function audienceCmd(rest: string[]): void {
  const [action, ...args] = rest;
  const cfg = loadRawGatewayConfig();
  switch (action) {
    case undefined:
    case "list": {
      println(chalk.bold("\npmk gateway audience"));
      println(`  default: ${chalk.cyan(cfg.audience.default)}`);
      const userEntries = Object.entries(cfg.audience.users);
      if (userEntries.length === 0) {
        println(chalk.dim("  (no per-user overrides)"));
      } else {
        println(chalk.dim("  per-user overrides:"));
        for (const [uid, aud] of userEntries) {
          println(`    ${uid.padEnd(14)} → ${aud}`);
        }
      }
      const channelEntries = Object.entries(cfg.audience.channels);
      if (channelEntries.length === 0) {
        println(chalk.dim("  (no per-channel overrides)"));
      } else {
        println(chalk.dim("  per-channel overrides:"));
        for (const [cid, aud] of channelEntries) {
          println(`    ${cid.padEnd(14)} → ${aud}`);
        }
      }
      println(
        chalk.dim(
          "  resolution order at turn time: per-user → per-channel → default",
        ),
      );
      return;
    }
    case "set": {
      const [userId, audience] = args;
      if (!userId || !audience) {
        audienceUsage();
        process.exit(1);
      }
      if (!ensureValidSlackUserId(userId)) process.exit(1);
      if (!isAudienceKey(audience)) {
        println(
          chalk.red(
            `invalid audience '${audience}'. Allowed: tech / pm / biz / sales / exec.`,
          ),
        );
        process.exit(1);
      }
      cfg.audience.users[userId] = audience;
      saveGatewayConfig(cfg);
      println(chalk.green(`set ${userId} → ${audience}`));
      return;
    }
    case "unset": {
      const [userId] = args;
      if (!userId) {
        audienceUsage();
        process.exit(1);
      }
      if (!ensureValidSlackUserId(userId)) process.exit(1);
      if (!(userId in cfg.audience.users)) {
        println(chalk.dim(`(${userId} had no override; nothing to do)`));
        return;
      }
      delete cfg.audience.users[userId];
      saveGatewayConfig(cfg);
      println(chalk.green(`removed override for ${userId}`));
      return;
    }
    case "set-channel": {
      const [channelId, audience] = args;
      if (!channelId || !audience) {
        audienceUsage();
        process.exit(1);
      }
      if (!ensureValidSlackChannelId(channelId)) process.exit(1);
      if (!isAudienceKey(audience)) {
        println(
          chalk.red(
            `invalid audience '${audience}'. Allowed: tech / pm / biz / sales / exec.`,
          ),
        );
        process.exit(1);
      }
      cfg.audience.channels[channelId] = audience;
      saveGatewayConfig(cfg);
      println(chalk.green(`set channel ${channelId} → ${audience}`));
      return;
    }
    case "unset-channel": {
      const [channelId] = args;
      if (!channelId) {
        audienceUsage();
        process.exit(1);
      }
      if (!ensureValidSlackChannelId(channelId)) process.exit(1);
      if (!(channelId in cfg.audience.channels)) {
        println(chalk.dim(`(${channelId} had no override; nothing to do)`));
        return;
      }
      delete cfg.audience.channels[channelId];
      saveGatewayConfig(cfg);
      println(chalk.green(`removed channel override for ${channelId}`));
      return;
    }
    case "default": {
      const [audience] = args;
      if (!audience || !isAudienceKey(audience)) {
        audienceUsage();
        process.exit(1);
      }
      cfg.audience.default = audience;
      saveGatewayConfig(cfg);
      println(chalk.green(`default audience set to ${audience}`));
      return;
    }
    case "example": {
      const examples = cfg.audience.domainExamples ?? { biz: [], pm: [] };
      cfg.audience.domainExamples = examples;
      if (!examples.biz) examples.biz = [];
      if (!examples.pm) examples.pm = [];
      const [exampleAction, ...exampleArgs] = args;
      switch (exampleAction) {
        case undefined:
        case "list": {
          const filter = exampleArgs[0];
          const tiers: ExampleTier[] =
            filter && isExampleTier(filter) ? [filter] : ["biz", "pm"];
          println(chalk.bold("\npmk gateway audience example"));
          for (const tier of tiers) {
            const rows = examples[tier] ?? [];
            if (rows.length === 0) {
              println(chalk.dim(`  ${tier}: (no workspace examples)`));
            } else {
              println(chalk.dim(`  ${tier}:`));
              for (const row of rows) {
                println(`    ${row.techForm.padEnd(20)} → ${row.targetForm}`);
              }
            }
          }
          println(
            chalk.dim(
              "  applied at prompt-assembly time; gateway restart required for changes to take effect.",
            ),
          );
          return;
        }
        case "add": {
          const [tier, techForm, ...targetParts] = exampleArgs;
          const targetForm = targetParts.join(" ").trim();
          if (!tier || !techForm || !targetForm) {
            audienceUsage();
            process.exit(1);
          }
          if (!isExampleTier(tier)) {
            println(
              chalk.red(
                `invalid tier '${tier}'. Only 'biz' and 'pm' carry translation tables.`,
              ),
            );
            process.exit(1);
          }
          const list = examples[tier]!;
          const existing = list.findIndex((e) => e.techForm === techForm);
          if (existing >= 0) {
            list[existing] = { techForm, targetForm };
            saveGatewayConfig(cfg);
            println(
              chalk.green(
                `updated ${tier} example: ${techForm} → ${targetForm}`,
              ),
            );
          } else {
            list.push({ techForm, targetForm });
            saveGatewayConfig(cfg);
            println(
              chalk.green(`added ${tier} example: ${techForm} → ${targetForm}`),
            );
          }
          return;
        }
        case "remove": {
          const [tier, techForm] = exampleArgs;
          if (!tier || !techForm) {
            audienceUsage();
            process.exit(1);
          }
          if (!isExampleTier(tier)) {
            println(
              chalk.red(
                `invalid tier '${tier}'. Only 'biz' and 'pm' carry translation tables.`,
              ),
            );
            process.exit(1);
          }
          const list = examples[tier]!;
          const idx = list.findIndex((e) => e.techForm === techForm);
          if (idx < 0) {
            println(
              chalk.dim(`(${tier} has no example for '${techForm}'; nothing to do)`),
            );
            return;
          }
          list.splice(idx, 1);
          saveGatewayConfig(cfg);
          println(chalk.green(`removed ${tier} example: ${techForm}`));
          return;
        }
        default:
          audienceUsage();
          process.exit(1);
      }
    }
    default:
      audienceUsage();
      process.exit(1);
  }
}
