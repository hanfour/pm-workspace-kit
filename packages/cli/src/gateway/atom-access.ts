import type { WebClient } from "@slack/web-api";
import type { KnowledgeAtom } from "./knowledge";

const TTL_MS = 5 * 60 * 1000;
interface Cached<T> { value: T; at: number; }

/** Channel-membership access checker for atom retrieval. Caches is_private +
 *  member sets for TTL_MS. Fail-closed on any lookup error. */
export function makeAtomAccessChecker(web: WebClient, now: () => number = () => Date.now()) {
  const pubCache = new Map<string, Cached<boolean>>();
  const memberCache = new Map<string, Cached<Set<string>>>();

  /** A channel is public ONLY if it is a real public Slack channel. DMs, group
   *  DMs, private channels, and any ambiguous response are NOT public. */
  async function isPublicChannel(channel: string): Promise<boolean> {
    const c = pubCache.get(channel);
    if (c && now() - c.at < TTL_MS) return c.value;
    const r = (await web.conversations.info({ channel })) as { channel?: { is_channel?: boolean; is_private?: boolean } };
    const value = r.channel?.is_channel === true && r.channel?.is_private === false;
    pubCache.set(channel, { value, at: now() });
    return value;
  }
  async function members(channel: string): Promise<Set<string>> {
    const c = memberCache.get(channel);
    if (c && now() - c.at < TTL_MS) return new Set(c.value); // copy — never hand out the live cached Set
    const r = (await web.conversations.members({ channel })) as { members?: string[] };
    const value = new Set(r.members ?? []);
    memberCache.set(channel, { value, at: now() });
    return new Set(value); // copy — protect the cached Set from caller mutation
  }

  return {
    async canUserAccessAtom(userId: string, atom: KnowledgeAtom): Promise<boolean> {
      const threadKey = atom.source?.threadKey ?? "";
      const channel = threadKey.includes(":") ? threadKey.split(":")[0] : "";
      if (!channel) return true; // legacy/general atom — was always retrievable
      try {
        if (await isPublicChannel(channel)) return true; // open public channel
        return (await members(channel)).has(userId);
      } catch {
        return false; // present-but-unresolvable channel → fail closed
      }
    },
  };
}
