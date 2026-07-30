import { WebClient } from "@slack/web-api";
import type { GatewayConfig } from "../config";
import { isAdmin } from "../config";
import { handleAdminSlash } from "./admin";
import type { RuntimeHealthSnapshot } from "./admin";
import {
  channelCasesDir,
  loadChannelMeta,
  saveChannelMeta,
  userCasesDir,
} from "../session-store";
import {
  assertSafeCaseName,
  caseExists,
  loadCase,
  newCase,
  renderCaseMarkdown,
  saveCase,
} from "../../case";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * v0.13 tranche 4: slash-command handler (envelope + parsed-arg paths),
 * extracted from `slack/index.ts` so the SlackAdapter shell stops being
 * the place where new `/pmk <verb>` cases land. Pure-helper types and
 * `slashCommandArgsFromBody` move with it; `slack/index.ts` re-exports
 * them so existing test imports (`gateway.test.ts`) keep working.
 */

export type SlashCommandScope =
  | { kind: "user"; userId: string }
  | { kind: "channel"; channelId: string };

export interface SlashCommandArgs {
  channelId: string;
  userId: string;
  rest: string;
  scope: SlashCommandScope;
}

/**
 * v0.9.1 (#39): pure translation of a Slack `slash_commands` envelope
 * body into the `SlashCommandHandler.run` arg shape. Exported for tests so
 * the rest/scope decision is verifiable without spinning up a
 * SlackAdapter (which needs real Slack tokens to construct).
 *
 * Returns null when the body lacks the minimum fields the handler
 * needs — caller should drop the envelope.
 */
export function slashCommandArgsFromBody(
  body: { user_id?: string; channel_id?: string; text?: string } | undefined,
): SlashCommandArgs | null {
  if (!body) return null;
  const userId = body.user_id;
  const channelId = body.channel_id;
  if (!userId || !channelId) return null;
  // Empty body text (user typed just `/pmk`) routes to the help surface
  // rather than a "未知指令" reply, so first-time users discover the
  // command list.
  const rest = (body.text ?? "").trim() || "help";
  const scope: SlashCommandScope = channelId.startsWith("D")
    ? { kind: "user", userId }
    : { kind: "channel", channelId };
  return { channelId, userId, rest, scope };
}

export interface SlashCommandHandlerOptions {
  web: WebClient;
  config: GatewayConfig;
  /**
   * Provider read at COMMAND time (not construction time) so the doctor
   * subcommand always reflects the live daemon state, not a frozen snapshot.
   * Absent in test setups that don't exercise `admin doctor`.
   */
  getRuntimeHealthSnapshot?: () => RuntimeHealthSnapshot;
}

export class SlashCommandHandler {
  private readonly web: WebClient;
  private readonly config: GatewayConfig;
  private readonly getRuntimeHealthSnapshot?: () => RuntimeHealthSnapshot;

  constructor(opts: SlashCommandHandlerOptions) {
    this.web = opts.web;
    this.config = opts.config;
    this.getRuntimeHealthSnapshot = opts.getRuntimeHealthSnapshot;
  }

  /**
   * Dispatch a parsed `/pmk <verb> ...` command. `threadTs` is optional:
   * omitted on the envelope path (slash commands have no anchoring
   * message), present on the legacy leading-space text-message path.
   *
   * Envelope-level concerns (ack, dedup, blocklist) stay on the
   * SlackAdapter — they apply to every Slack event type, not just
   * slash. The adapter calls `run(args)` after those checks pass.
   */
  async run(args: {
    channelId: string;
    threadTs?: string;
    userId: string;
    rest: string;
    scope: SlashCommandScope;
  }): Promise<void> {
    const { channelId, threadTs, userId, rest, scope } = args;
    const [cmd, ...tokens] = rest.split(/\s+/);
    const arg = tokens.join(" ").trim();
    const dir =
      scope.kind === "user"
        ? userCasesDir(scope.userId)
        : channelCasesDir(scope.channelId);

    const reply = (text: string) =>
      this.web.chat.postMessage({
        channel: channelId,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        text,
      });

    switch (cmd) {
      case "help":
        await reply(
          "*pmk slash commands*\n" +
            "• `/pmk open <name>` — 建立 / 開啟 case\n" +
            "• `/pmk show <name>` — 顯示 case 全貌\n" +
            "• `/pmk close <name> [reason]` — 結案\n" +
            "• `/pmk cases` — 列出此 scope 的 cases\n" +
            "• `/pmk help` — 這份說明\n" +
            "\n*附件*:直接附上檔案(文字 / markdown / 程式碼 / PDF / 圖片)我就會讀進來當這個對話的參考;在同一個 thread 裡接著問即可。",
        );
        return;

      case "open": {
        if (!arg) return void (await reply("usage: `/pmk open <name>`"));
        if (!isSafeCaseName(arg)) {
          await reply("case 名稱不可包含路徑分隔符、`..` 或控制字元。");
          return;
        }
        if (caseExists(arg, dir)) {
          if (scope.kind === "channel") {
            const meta = loadChannelMeta(scope.channelId);
            meta.activeCase = arg;
            saveChannelMeta(meta);
          }
          await reply(
            `已切換 active case 為 \`${arg}\`。直接 @pmk 講話即可，pmk 會自動追蹤。`,
          );
          return;
        }
        const c = newCase({
          name: arg,
          title: arg.replace(/-/g, " "),
          ingest: this.config.defaultIngest ? [this.config.defaultIngest] : [],
        });
        saveCase(c, dir);
        if (scope.kind === "channel") {
          const meta = loadChannelMeta(scope.channelId);
          meta.activeCase = arg;
          saveChannelMeta(meta);
        }
        await reply(`新 case \`${arg}\` 建立完成。`);
        return;
      }

      case "show": {
        const target =
          arg ||
          (scope.kind === "channel"
            ? loadChannelMeta(scope.channelId).activeCase
            : undefined);
        if (!target) return void (await reply("usage: `/pmk show <name>`"));
        if (!isSafeCaseName(target)) {
          await reply("case 名稱不可包含路徑分隔符、`..` 或控制字元。");
          return;
        }
        if (!caseExists(target, dir))
          return void (await reply(`找不到 case \`${target}\`。`));
        const c = loadCase(target, dir);
        await reply("```" + renderCaseMarkdown(c).slice(0, 3500) + "```");
        return;
      }

      case "close": {
        if (!arg)
          return void (await reply("usage: `/pmk close <name> [reason]`"));
        const [name, ...reasonParts] = arg.split(/\s+/);
        if (!isSafeCaseName(name)) {
          await reply("case 名稱不可包含路徑分隔符、`..` 或控制字元。");
          return;
        }
        if (!caseExists(name, dir))
          return void (await reply(`找不到 case \`${name}\`。`));
        const c = loadCase(name, dir);
        c.status = "closed";
        if (reasonParts.length) c.resolution = reasonParts.join(" ");
        saveCase(c, dir);
        await reply(`case \`${name}\` 已結案。`);
        return;
      }

      case "cases": {
        const files = fs.existsSync(dir)
          ? fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
          : [];
        if (files.length === 0)
          return void (await reply("(此 scope 還沒有 case)"));
        const lines = files.map((f) => `• \`${path.basename(f, ".json")}\``);
        await reply(["*Cases*", ...lines].join("\n"));
        return;
      }

      // v0.9.0 (#31): admin-restricted, DM-only gateway-config mutations.
      // Bootstrap (the very first admin) requires terminal access via
      // `pmk gateway admin add` — there is no Slack path to grant
      // yourself admin, by design.
      case "admin": {
        if (scope.kind !== "user") {
          await reply(":no_entry_sign: `/pmk admin` 只能在 DM 使用。");
          return;
        }
        if (!isAdmin(this.config, userId)) {
          await reply(":lock: 此命令限管理員使用。");
          return;
        }
        const result = await handleAdminSlash({
          actor: userId,
          tokens,
          getRuntimeHealthSnapshot: this.getRuntimeHealthSnapshot,
        });
        await reply(result.text);
        return;
      }

      default:
        await reply(`未知指令 \`${cmd}\`。試試 \`/pmk help\`。`);
    }
  }
}

function isSafeCaseName(name: string): boolean {
  try {
    assertSafeCaseName(name);
    return true;
  } catch {
    return false;
  }
}
