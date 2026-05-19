/**
 * Gateway presence broadcaster. Owns the `gateway.online` /
 * `gateway.offline` audit events and the fan-out posts that
 * notify recently-active DMs + channels.
 *
 * #44 behaviour preserved verbatim from the prior inline methods on
 * `SlackAdapter`:
 * - `offline()` always broadcasts (operators need the going-down
 *   notice even when the corresponding back-up is suppressed).
 * - `backOnline()` suppresses the broadcast on fast restarts
 *   (offline window shorter than {@link MIN_BROADCAST_GAP_MS}) so
 *   kill→restart loops don't stack stale notices, but still records
 *   the transition in `events.log` with `broadcast: false` so the
 *   audit can detect churn.
 *
 * Errors per fan-out recipient are swallowed — one rejected DM
 * (user left workspace) or kicked-bot channel must not abort the
 * rest. Same rationale as the pre-extract `broadcast()` method.
 */
import type { WebClient } from "@slack/web-api";
import {
  formatBackOnlineNotice,
  formatOfflineNotice,
} from "../formatters";
import { appendGatewayEvent } from "../events";
import {
  listRecentChannels,
  listRecentUsers,
} from "../session-store";
import { runWithConcurrency } from "./concurrency";

/**
 * Suppress back-online broadcasts when the offline window is shorter
 * than this — catches rapid kill→restart cycles that would otherwise
 * spam every recently-active user/channel with stacked notices.
 */
export const MIN_BROADCAST_GAP_MS = 5 * 60_000;

/**
 * Concurrency cap for fan-out broadcast posts. Slack
 * `chat.postMessage` Tier 3 limit is ~50 req/min/channel; spreading
 * the fan-out at concurrency=3 keeps us well under cap and finishes
 * a full broadcast in seconds rather than the prior O(N) serial
 * pattern that took 20+ s.
 */
export const BROADCAST_CONCURRENCY = 3;

export interface PresenceBroadcasterOptions {
  web: WebClient;
  onLog: (msg: string) => void;
  /**
   * Apparent offline duration in ms — sourced from the
   * graceful-shutdown marker if present, else from `lastSeenAt`.
   * `undefined` means "no prior offline state observed" (first-ever
   * boot or marker missing); `backOnline()` treats undefined the
   * same as a non-fast-restart and broadcasts as `crash-recovery`.
   */
  offlineDurationMs?: number;
  /** Was the previous exit a graceful shutdown? */
  gracefulShutdown: boolean;
}

export class PresenceBroadcaster {
  /** Monotonic sequence for presence events emitted by this process. */
  private seq = 0;

  constructor(private readonly opts: PresenceBroadcasterOptions) {}

  async offline(): Promise<void> {
    const seq = ++this.seq;
    const text = formatOfflineNotice();
    await this.broadcast(text);
    appendGatewayEvent({
      type: "gateway.offline",
      seq,
      reason: "shutdown",
      broadcast: true,
    });
  }

  async backOnline(): Promise<void> {
    const seq = ++this.seq;
    const dur = this.opts.offlineDurationMs;
    const fastRestart = dur !== undefined && dur < MIN_BROADCAST_GAP_MS;
    if (fastRestart) {
      const reason = this.opts.gracefulShutdown
        ? "graceful-fast-restart"
        : "fast-recovery";
      this.opts.onLog(
        `back-online suppressed (offline ${dur}ms < ${MIN_BROADCAST_GAP_MS}ms, ${reason})`,
      );
      appendGatewayEvent({
        type: "gateway.online",
        seq,
        reason,
        broadcast: false,
        offlineDurationMs: dur,
      });
      return;
    }
    const text = formatBackOnlineNotice(dur);
    await this.broadcast(text);
    appendGatewayEvent({
      type: "gateway.online",
      seq,
      reason: this.opts.gracefulShutdown
        ? "graceful-long-downtime"
        : "crash-recovery",
      broadcast: true,
      offlineDurationMs: dur,
    });
  }

  /**
   * Fan-out a presence notice to every recently-active DM + channel.
   * Bounded-concurrency to stay under Slack rate-limits and avoid
   * the 20+ s SIGTERM-truncation problem the pre-#44 serial loop
   * had.
   */
  private async broadcast(text: string): Promise<void> {
    const userIds = listRecentUsers(24);
    const channels = listRecentChannels(24);
    const tasks: Array<() => Promise<unknown>> = [
      ...userIds.map((uid) => () => this.dmSafe(uid, text)),
      ...channels.map(
        (c) => () =>
          this.opts.web.chat.postMessage({ channel: c.channelId, text }).catch(() => {
            /* bot may have been kicked from the channel; skip silently */
          }),
      ),
    ];
    await runWithConcurrency(BROADCAST_CONCURRENCY, tasks);
  }

  private async dmSafe(uid: string, text: string): Promise<void> {
    try {
      const im = await this.opts.web.conversations.open({ users: uid });
      const channel = im.channel?.id;
      if (channel) {
        await this.opts.web.chat.postMessage({ channel, text });
      }
    } catch {
      /* user may have left workspace; skip */
    }
  }
}
