import chalk from "chalk";
import { WebClient } from "@slack/web-api";
import { seedAcmeAdsAtoms, unseedAcmeAdsAtoms } from "../gateway/acme-ads-seed";
import { gatewayRunningPid } from "../gateway/index";
import { loadGatewayConfig } from "../gateway/config";
import { readGatewayEvents } from "../gateway/events";
import { ACME_ADS_DEMO_SCRIPT, isFinalAnswerText, type DemoTranscript } from "../gateway/demo/acme-ads-script";
import { matchTurnEvent, runDemo } from "../gateway/demo/demo-runner";
import { println } from "../io";

const AWAIT_TURN_POLL_MS = 2000;
const READ_REPLY_POLL_MS = 1500;
const STABILITY_WINDOW_MS = 3000; // must exceed READ_REPLY_POLL_MS so ≥2 matching polls are required
const POSTED_AT_EPSILON_MS = 1000; // events file may be written just before now() is sampled post-`post`
const READ_REPLY_CAP_CEIL_MS = 30_000; // upper bound on the post-event wait for the final chat.update

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Find the bot reply's text within a thread's messages by its ts. */
export function pickReplyText(
  messages: ReadonlyArray<{ ts?: string; text?: string }>,
  replyTs: string,
): string {
  const m = messages.find((x) => x.ts === replyTs);
  return String(m?.text ?? "");
}

export function renderTranscript(t: DemoTranscript): string {
  const lines: string[] = [];
  lines.push(chalk.bold(`\npmk demo transcript — channel ${t.channelId}${t.dryRun ? " (dry-run)" : ""}`));
  t.turns.forEach((turn, i) => {
    lines.push("");
    lines.push(chalk.cyan(`Q${i + 1}: ${turn.question}`));
    lines.push(turn.answer ? `A${i + 1}: ${turn.answer}` : chalk.dim("(dry-run — not posted)"));
  });
  return lines.join("\n");
}

export async function demoCommand(
  sub: string | undefined,
  opts: { channel?: string; dm?: boolean; dryRun?: boolean; timeout?: string },
): Promise<void> {
  if (sub === "seed") {
    const r = seedAcmeAdsAtoms();
    println(chalk.green(r.alreadyPresent ? "✓ AcmeAds atoms already present" : `✓ seeded ${r.atomIds.length} AcmeAds atoms`));
    return;
  }
  if (sub === "unseed") {
    const r = unseedAcmeAdsAtoms();
    println(chalk.green(`✓ removed ${r.removedIds.length} AcmeAds atoms`));
    return;
  }
  if (sub !== "run") {
    println(chalk.yellow("usage: pmk demo <seed|unseed|run [--channel <id>] [--dry-run] [--timeout <sec>]>"));
    process.exit(1);
  }

  if (gatewayRunningPid() === undefined) {
    println(chalk.red("gateway is not running — start it first: pmk gateway start"));
    process.exit(1);
  }
  // Resolved below: without --channel/env (or with --dm) we auto-open the
  // demo user's DM with the bot (needs botUserId first), so it's zero-config.
  // --dm forces the DM path regardless of a sticky PMK_DEMO_CHANNEL.
  let channelId = opts.dm ? undefined : (opts.channel ?? process.env.PMK_DEMO_CHANNEL);
  const userToken = process.env.PMK_DEMO_USER_TOKEN;
  if (!userToken || !userToken.startsWith("xoxp-")) {
    println(chalk.red("set PMK_DEMO_USER_TOKEN to a Slack user OAuth token (xoxp-…)"));
    process.exit(1);
  }
  const timeoutMs = Math.max(1, Number.parseInt(opts.timeout ?? "120", 10) || 120) * 1000;

  const userWeb = new WebClient(userToken);
  const userAuth = await userWeb.auth.test().catch(() => null);
  if (!userAuth?.ok || (userAuth as { bot_id?: string } /* @slack/web-api's AuthTestResponse type omits bot_id; present on bot-token responses */).bot_id) {
    println(chalk.red("PMK_DEMO_USER_TOKEN did not auth as a user (a user token, not a bot token, is required)"));
    process.exit(1);
  }
  const demoUserId = String(userAuth.user_id);

  const cfg = loadGatewayConfig();
  const botWeb = new WebClient(cfg.slack.botToken);
  const botAuth = await botWeb.auth.test().catch(() => null);
  if (!botAuth?.ok) {
    println(chalk.red("gateway bot token failed auth.test — run pmk gateway doctor"));
    process.exit(1);
  }
  const botUserId = String(botAuth.user_id);

  let isDm: boolean;
  if (!channelId) {
    // Zero-config default: open the demo user's DM with the bot. Either
    // party's token can open it, so we try the user token first (it "is"
    // the user) then the bot — a single im:write on either side suffices.
    // The bot already has im:history, so reply-readback works here without
    // the channels:history a public channel would require.
    const openDm = async (web: WebClient, users: string): Promise<string | null> =>
      web.conversations.open({ users }).then(
        (r) => (r.channel as { id?: string } | undefined)?.id ?? null,
        () => null,
      );
    const opened = (await openDm(userWeb, botUserId)) ?? (await openDm(botWeb, demoUserId));
    if (!opened) {
      println(chalk.red(
        "could not open a DM with the bot — grant im:write to the user or bot token, or pass --channel <id>",
      ));
      process.exit(1);
    }
    channelId = opened;
    isDm = true;
    println(chalk.dim(`  (auto-opened DM ${channelId} with the bot)`));
  } else {
    const info = await botWeb.conversations.info({ channel: channelId }).catch(() => null);
    if (!info) {
      println(chalk.dim(`  (could not read channel info — proceeding assuming a non-DM channel; ensure the bot can read ${channelId})`));
    }
    isDm = (info?.channel as { is_im?: boolean } | undefined)?.is_im === true;
    if (info && !isDm && (info.channel as { is_member?: boolean }).is_member === false) {
      println(chalk.red(`the bot is not a member of ${channelId} — invite it, or use a DM channel`));
      process.exit(1);
    }
  }

  println(chalk.bold(`\npmk demo run`));
  println(chalk.dim(`  channel: ${channelId}${isDm ? " (DM)" : ""}; posting ${ACME_ADS_DEMO_SCRIPT.length} questions as <@${demoUserId}>${opts.dryRun ? " [dry-run]" : ""}`));

  seedAcmeAdsAtoms();

  const transcript = await runDemo({
    script: ACME_ADS_DEMO_SCRIPT,
    channelId, isDm, botUserId,
    dryRun: opts.dryRun === true,
    timeoutMs,
    now: () => Date.now(),
    post: async (text) => {
      const res = await userWeb.chat.postMessage({ channel: channelId, text });
      return { ts: String(res.ts) };
    },
    awaitTurn: async (postedTs, postedAtMs, tMs) => {
      const deadline = Date.now() + tMs;
      while (Date.now() < deadline) {
        const events = readGatewayEvents({ sinceMs: postedAtMs - POSTED_AT_EPSILON_MS });
        const m = matchTurnEvent(events, {
          channelId, actor: demoUserId, sincePostedAtMs: postedAtMs,
          // Non-DM: pin turn to the exact thread anchored at the posted message.
          // DM: omit threadTs — the gateway threads DM replies identically
          // (thread_ts = event.thread_ts ?? event.ts), but one-at-a-time
          // sequencing (actor + channel + time) is already sufficient to
          // identify the turn uniquely without the thread filter.
          threadTs: isDm ? undefined : postedTs,
        });
        if (m) return m;
        await sleep(AWAIT_TURN_POLL_MS);
      }
      return null;
    },
    readReply: async (parentTs, replyTs) => {
      const deadline = Date.now() + Math.min(timeoutMs, READ_REPLY_CAP_CEIL_MS);
      let last = "";
      let stableSince = 0;
      // Surface (don't swallow) the reply-read failure: a missing bot scope
      // (e.g. channels:history for a public channel) makes conversations.replies
      // throw, and a silent null here is indistinguishable from "no final
      // answer yet" — which sends the operator chasing the wrong layer.
      let readErr = "";
      while (Date.now() < deadline) {
        const res = await botWeb.conversations
          .replies({ channel: channelId, ts: parentTs, limit: 200 })
          .catch((e: unknown) => {
            readErr = e instanceof Error ? e.message : String(e);
            return null;
          });
        const text = pickReplyText(
          (res?.messages ?? []) as ReadonlyArray<{ ts?: string; text?: string }>,
          replyTs,
        );
        if (isFinalAnswerText(text)) {
          readErr = "";
          if (text === last) {
            if (stableSince && Date.now() - stableSince >= STABILITY_WINDOW_MS) return text;
            // else: still within the stability window — keep waiting
          } else {
            last = text;
            stableSince = Date.now();
          }
        } else {
          last = "";
          stableSince = 0;
        }
        await sleep(READ_REPLY_POLL_MS);
      }
      if (last) return last;
      return readErr
        ? `(could not read replies: ${readErr})`
        : "(answer did not stabilise)";
    },
  });

  println(renderTranscript(transcript));
}
