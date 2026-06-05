import chalk from "chalk";
import { println } from "../../io";
import { loadRawGatewayConfig, saveGatewayConfig } from "../../gateway/config";
import { appendAdminLog, cliActor } from "../../gateway/admin-log";
import { ensureValidSlackUserId } from "./shared";

// v0.9.0 (#31): host-side bootstrap for the Slack admin commands.
// The first admin can only be added from a terminal — there's no
// /pmk admin admins add @first-admin path because no one is yet
// admin to authorise it.

export function adminBootstrapUsage(): void {
  println(
    chalk.yellow(
      "usage:\n" +
        "  pmk gateway admin list\n" +
        "  pmk gateway admin add <userId>\n" +
        "  pmk gateway admin remove <userId>\n" +
        "  pmk gateway admin audit [N]   (last N entries from admin.log; default 20)",
    ),
  );
}

export function adminBootstrapCmd(rest: string[]): void {
  const [action, target] = rest;
  const cfg = loadRawGatewayConfig();
  switch (action) {
    case undefined:
    case "list": {
      println(chalk.bold("\npmk gateway admin"));
      if (cfg.admins.length === 0) {
        println(
          chalk.dim(
            "  (none — Slack /pmk admin commands disabled until at least one is added)",
          ),
        );
        println(
          chalk.dim(
            "  add yourself: pmk gateway admin add <your-Slack-userId>",
          ),
        );
        return;
      }
      for (const id of cfg.admins) println(`  ${id}`);
      return;
    }
    case "add": {
      if (!target) {
        adminBootstrapUsage();
        process.exit(1);
      }
      if (!ensureValidSlackUserId(target)) {
        appendAdminLog({
          actor: cliActor(),
          origin: "cli",
          action: "admins.add",
          args: target,
          ok: false,
          reason: "invalid Slack user ID",
        });
        process.exit(1);
      }
      if (cfg.admins.includes(target)) {
        println(chalk.dim(`(${target} already an admin; nothing to do)`));
        return;
      }
      cfg.admins.push(target);
      saveGatewayConfig(cfg);
      println(chalk.green(`added ${target} to admins`));
      appendAdminLog({
        actor: cliActor(),
        origin: "cli",
        action: "admins.add",
        args: target,
        ok: true,
      });
      return;
    }
    case "remove": {
      if (!target) {
        adminBootstrapUsage();
        process.exit(1);
      }
      if (!cfg.admins.includes(target)) {
        println(chalk.dim(`(${target} not in admin list; nothing to do)`));
        return;
      }
      // Last-admin protection — host can lock themselves out otherwise.
      if (cfg.admins.length === 1) {
        println(
          chalk.red(
            `cannot remove ${target}: last remaining admin. Add a replacement first.`,
          ),
        );
        appendAdminLog({
          actor: cliActor(),
          origin: "cli",
          action: "admins.remove",
          args: target,
          ok: false,
          reason: "last-admin protection",
        });
        process.exit(1);
      }
      cfg.admins = cfg.admins.filter((id) => id !== target);
      saveGatewayConfig(cfg);
      println(chalk.green(`removed ${target} from admins`));
      appendAdminLog({
        actor: cliActor(),
        origin: "cli",
        action: "admins.remove",
        args: target,
        ok: true,
      });
      return;
    }
    case "audit": {
      const nArg = target ? Number.parseInt(target, 10) : NaN;
      const n = Number.isFinite(nArg) && nArg > 0 ? nArg : 20;
      // Lazy import so the regular gateway commands don't pull in
      // admin-log unless they need to read it.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { readAdminLog } =
        require("../../gateway/admin-log") as typeof import("../../gateway/admin-log");
      const entries = readAdminLog(n);
      println(chalk.bold(`\npmk gateway admin audit (last ${entries.length})`));
      if (entries.length === 0) {
        println(chalk.dim("  (no entries yet)"));
        return;
      }
      for (const e of entries) {
        const at = (e as { at?: string }).at?.slice(11, 19) ?? "??:??:??";
        const okMark = e.ok ? chalk.green("ok ") : chalk.red("err");
        const tail = e.args ? ` ${e.args}` : "";
        const reason = !e.ok && e.reason ? chalk.dim(` (${e.reason})`) : "";
        println(
          `  ${at}  ${okMark}  ${e.origin.padEnd(5)}  ${e.actor.padEnd(20).slice(0, 20)}  ${e.action}${tail}${reason}`,
        );
      }
      return;
    }
    default:
      adminBootstrapUsage();
      process.exit(1);
  }
}
