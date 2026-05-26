// Outermost-layer WebClient proxy for `pmk gateway start --dry-run`.
//
// FR3 of PRD-2026-0006. Per sprint plan M3 Risk 3: "dry-run 漏寫攔截"
// — interception MUST happen here, not in each caller. Any Slack
// write triggered through this proxy is logged to stderr and returned
// as `{ ok: true, dry_run: true }`; reads pass through to the real
// underlying WebClient unchanged.

import type { WebClient } from "@slack/web-api";

// Methods that produce visible side effects in the Slack workspace.
// Allowlist of writes (instead of denylist of reads) so that an
// unfamiliar new method coming through default-passes-through; if
// you add support for a new write call site, ADD ITS METHOD NAME
// HERE in the same PR.
const WRITE_METHODS = new Set<string>([
  // chat.*
  "chat.postMessage",
  "chat.postEphemeral",
  "chat.update",
  "chat.delete",
  "chat.scheduleMessage",
  "chat.deleteScheduledMessage",
  "chat.unfurl",
  "chat.meMessage",
  // reactions.*
  "reactions.add",
  "reactions.remove",
  // files.*
  "files.upload",
  "files.uploadV2",
  "files.delete",
  // pins.*
  "pins.add",
  "pins.remove",
  // conversations.* (state-changing)
  "conversations.create",
  "conversations.invite",
  "conversations.kick",
  "conversations.leave",
  "conversations.archive",
  "conversations.unarchive",
  "conversations.rename",
  "conversations.setTopic",
  "conversations.setPurpose",
  "conversations.join",
  // views.* (modals + Home tab)
  "views.publish",
  "views.open",
  "views.update",
  "views.push",
]);

export interface DryRunStats {
  postMessage: number;
  postEphemeral: number;
  reactionAdd: number;
  otherWrites: number;
}

export type DryRunStubLogger = (method: string, payload: unknown) => void;

export function createDryRunStats(): DryRunStats {
  return {
    postMessage: 0,
    postEphemeral: 0,
    reactionAdd: 0,
    otherWrites: 0,
  };
}

/**
 * Wrap a WebClient so all Slack writes are stubbed. The returned value
 * is structurally compatible with WebClient — every namespace and
 * method is preserved; only the listed WRITE_METHODS short-circuit.
 *
 * `stats` is mutated in place when a write is intercepted. Pass a
 * fresh one if you want per-session counters.
 */
export function wrapWebClientForDryRun(
  web: WebClient,
  opts: { stats?: DryRunStats; log?: DryRunStubLogger } = {},
): WebClient {
  const stats = opts.stats;
  const log = opts.log ?? defaultLog;
  return makeProxy(web as unknown, [], log, stats) as WebClient;
}

function makeProxy(
  target: unknown,
  pathParts: string[],
  log: DryRunStubLogger,
  stats: DryRunStats | undefined,
): unknown {
  if (target === null || target === undefined) return target;
  if (typeof target !== "object" && typeof target !== "function") {
    return target;
  }
  return new Proxy(target as object, {
    get(t, prop, receiver) {
      if (typeof prop !== "string") {
        return Reflect.get(t, prop, receiver);
      }
      const original = Reflect.get(t, prop, receiver);
      const newPath = [...pathParts, prop];
      const fullName = newPath.join(".");
      if (typeof original === "function") {
        if (WRITE_METHODS.has(fullName)) {
          return async (...args: unknown[]) => {
            bumpStats(stats, fullName);
            log(fullName, args[0]);
            return { ok: true, dry_run: true };
          };
        }
        return original.bind(t);
      }
      if (original !== null && typeof original === "object") {
        // Recurse into namespaces (chat, reactions, files, …) so
        // `web.chat.postMessage` correctly resolves to a stub even
        // though only `chat.postMessage` is in WRITE_METHODS.
        return makeProxy(original, newPath, log, stats);
      }
      return original;
    },
  });
}

function bumpStats(stats: DryRunStats | undefined, fullName: string): void {
  if (!stats) return;
  switch (fullName) {
    case "chat.postMessage":
      stats.postMessage += 1;
      break;
    case "chat.postEphemeral":
      stats.postEphemeral += 1;
      break;
    case "reactions.add":
      stats.reactionAdd += 1;
      break;
    default:
      stats.otherWrites += 1;
  }
}

function defaultLog(method: string, payload: unknown): void {
  const summary = summarizePayload(payload);
  process.stderr.write(
    summary ? `[dry-run] ${method} ${summary}\n` : `[dry-run] ${method}\n`,
  );
}

function summarizePayload(p: unknown): string {
  if (!p || typeof p !== "object") return "";
  const obj = p as Record<string, unknown>;
  const channel = obj.channel ? `channel=${String(obj.channel)}` : "";
  const user = obj.user ? `user=${String(obj.user)}` : "";
  const name = obj.name ? `name=${String(obj.name)}` : "";
  const text =
    typeof obj.text === "string" && obj.text.length > 0
      ? `text="${obj.text.replace(/\s+/g, " ").slice(0, 60)}${obj.text.length > 60 ? "…" : ""}"`
      : "";
  return [channel, user, name, text].filter(Boolean).join(" ");
}

/**
 * True when the current process is in dry-run mode. Read at runtime
 * by `gatewayEventsPath()` so monthly events are routed to
 * `dryrun-events-YYYY-MM.log`, and by the SlackAdapter when deciding
 * whether to wrap the WebClient. Tests can set / unset this around
 * each case.
 */
export function isDryRunActive(): boolean {
  return process.env.PMK_DRY_RUN === "1";
}
