/**
 * Minimal payload shapes for the Slack Socket-Mode events the gateway handles
 * (message / app_mention / reaction_added / slash-command). These mirror only
 * the fields pmk reads — the full @slack/socket-mode types are broader. Kept in
 * their own module so the adapter and its extracted handlers share one source.
 */
import type { SlackFile } from "../attachments/types";

export namespace Slack {
  export interface MessageEvent {
    type: "message";
    user?: string;
    bot_id?: string;
    text?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    subtype?: string;
    files?: SlackFile[];
  }
  export interface AppMentionEvent {
    type: "app_mention";
    user?: string;
    text?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    files?: SlackFile[];
  }
  export interface MessageEventPayload {
    ack?: (response?: unknown) => Promise<void>;
    envelope_id: string;
    retry_num?: number;
    retry_reason?: string;
    event?: MessageEvent;
  }
  export interface AppMentionEventPayload {
    ack?: (response?: unknown) => Promise<void>;
    envelope_id: string;
    retry_num?: number;
    retry_reason?: string;
    event?: AppMentionEvent;
  }
  // v0.8.5 (#21) — reactions:read scope on the Slack app side.
  export interface ReactionEvent {
    type: "reaction_added";
    user?: string;
    reaction?: string;
    item_user?: string;
    item?: { type: string; channel: string; ts: string };
  }
  export interface ReactionEventPayload {
    ack?: (response?: unknown) => Promise<void>;
    envelope_id: string;
    retry_num?: number;
    retry_reason?: string;
    event?: ReactionEvent;
  }
  // v0.9.1 (#39) — real Slack slash-command envelopes. Shape per
  // @slack/socket-mode body.
  export interface SlashCommandBody {
    command?: string;
    text?: string;
    user_id?: string;
    channel_id?: string;
    response_url?: string;
    trigger_id?: string;
    team_id?: string;
  }
  export interface SlashCommandPayload {
    ack?: (response?: unknown) => Promise<void>;
    envelope_id: string;
    retry_num?: number;
    retry_reason?: string;
    body?: SlashCommandBody;
  }
}
