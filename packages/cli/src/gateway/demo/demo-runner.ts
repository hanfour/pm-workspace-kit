import type { StoredGatewayEvent } from "../events";
import type { DemoTranscript, DemoTurn } from "./acme-ads-script";

export interface MatchTurnCriteria {
  channelId: string;
  actor: string;
  sincePostedAtMs: number;
  /** Non-DM: pin the exact turn by the thread anchored at the posted ts. */
  threadTs?: string;
}

/**
 * The first turn.processed event for this demo turn: same channel + actor,
 * emitted after the question was posted, and (for non-DM) threaded under
 * the posted ts. Pure — operates on an already-read event slice.
 */
export function matchTurnEvent(
  events: StoredGatewayEvent[],
  c: MatchTurnCriteria,
): { replyTs: string } | null {
  for (const e of events) {
    if (e.type !== "turn.processed") continue;
    if (e.channelId !== c.channelId) continue;
    if (e.actor !== c.actor) continue;
    if (Date.parse(e.at) <= c.sincePostedAtMs) continue;
    if (c.threadTs !== undefined && e.threadTs !== c.threadTs) continue;
    if (!e.replyTs) continue;
    return { replyTs: e.replyTs };
  }
  return null;
}

export interface RunDemoDeps {
  script: readonly string[];
  channelId: string;
  isDm: boolean;
  botUserId: string;
  dryRun: boolean;
  timeoutMs: number;
  post: (text: string) => Promise<{ ts: string }>;
  awaitTurn: (postedTs: string, postedAtMs: number, timeoutMs: number) => Promise<{ replyTs: string } | null>;
  readReply: (parentTs: string, replyTs: string) => Promise<string>;
  now: () => number;
}

export async function runDemo(deps: RunDemoDeps): Promise<DemoTranscript> {
  const turns: DemoTurn[] = [];
  for (const q of deps.script) {
    const text = deps.isDm ? q : `<@${deps.botUserId}> ${q}`;
    if (deps.dryRun) {
      turns.push({ question: text, posted: false, answer: null, replyTs: null });
      continue;
    }
    const postedAtMs = deps.now();
    const { ts } = await deps.post(text);
    const matched = await deps.awaitTurn(ts, postedAtMs, deps.timeoutMs);
    if (!matched) {
      turns.push({
        question: text,
        posted: true,
        answer: `(no reply within ${Math.round(deps.timeoutMs / 1000)}s)`,
        replyTs: null,
      });
      continue;
    }
    const answer = await deps.readReply(ts, matched.replyTs);
    turns.push({ question: text, posted: true, answer, replyTs: matched.replyTs });
  }
  return { channelId: deps.channelId, dryRun: deps.dryRun, turns };
}
