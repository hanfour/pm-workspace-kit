// Defense-in-depth WebClient proxy that caps the `text` field of every
// outgoing chat.* write at Slack's hard limit.
//
// Slack rejects a chat.postMessage / chat.update whose `text` exceeds
// 40,000 characters with `msg_too_long` (surfaced by @slack/web-api as
// "An API error occurred: msg_too_long"). Individual call sites are
// SUPPOSED to run user/model-generated text through `truncateForSlack`,
// but relying on every site to remember is fragile — escalation posts
// and the top-level error handlers embedded unbounded model questions /
// error messages raw and leaked msg_too_long in production.
//
// This proxy is the single chokepoint: wrap the real WebClient once and
// no call site can post an over-long `text` again. It mirrors
// `wrapWebClientForDryRun`'s structure (namespace-recursing Proxy,
// allowlist of methods) and composes with it.

import type { WebClient } from "@slack/web-api";
import { truncateForSlack } from "../formatters";

/** chat.* methods whose `text` field Slack hard-caps at 40,000 chars. */
const TEXT_CAP_METHODS = new Set<string>([
  "chat.postMessage",
  "chat.update",
  "chat.postEphemeral",
  "chat.scheduleMessage",
  "chat.meMessage",
]);

/**
 * Wrap a WebClient so every listed chat.* write has its `text` capped
 * via `truncateForSlack`. Structurally compatible with WebClient: all
 * namespaces and methods pass through; only an over-long `text` on a
 * capped method is rewritten (on a fresh payload — the caller's object
 * is never mutated). Reads and non-text writes are untouched.
 */
export function wrapWebClientWithTextCap(web: WebClient): WebClient {
  return makeProxy(web as unknown, []) as WebClient;
}

function makeProxy(target: unknown, pathParts: string[]): unknown {
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
        if (TEXT_CAP_METHODS.has(fullName)) {
          return (...args: unknown[]) =>
            (original as (...a: unknown[]) => unknown).apply(t, capTextArg(args));
        }
        return original.bind(t);
      }
      if (original !== null && typeof original === "object") {
        // Recurse into namespaces (chat, …) so `web.chat.postMessage`
        // resolves to the capped wrapper even though only the dotted
        // method name is in TEXT_CAP_METHODS.
        return makeProxy(original, newPath);
      }
      return original;
    },
  });
}

/**
 * Return a copy of the argument list with the first arg's `text` capped,
 * when it is an over-long string. Immutable: builds a fresh payload
 * rather than mutating the caller's object.
 */
function capTextArg(args: unknown[]): unknown[] {
  const [payload, ...rest] = args;
  if (
    payload !== null &&
    typeof payload === "object" &&
    typeof (payload as { text?: unknown }).text === "string"
  ) {
    const p = payload as Record<string, unknown> & { text: string };
    const capped = truncateForSlack(p.text);
    if (capped !== p.text) {
      return [{ ...p, text: capped }, ...rest];
    }
  }
  return args;
}
