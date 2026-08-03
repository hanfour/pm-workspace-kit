import type { WebClient } from "@slack/web-api";
import type { KnowledgeAtom } from "./knowledge";

const TTL_MS = 5 * 60 * 1000;
interface Cached<T> { value: T; at: number; }

/**
 * The channel segment of a `<channel>:<ts>` thread key, or undefined when the
 * key does not carry one.
 *
 * Split out and made total on purpose: the previous inline parse mapped every
 * unparseable shape ("", "CPRIV" with no colon, ":123" with an empty segment)
 * onto the same empty string, which the caller then treated as "legacy →
 * allow". Returning undefined forces the caller to make that a denial.
 */
export function parseAtomChannel(threadKey: string): string | undefined {
  const channel = threadKey.split(":")[0];
  return channel.length > 0 ? channel : undefined;
}

/** Channel-membership access checker for atom retrieval. Caches is_private +
 *  member sets for TTL_MS. Fail-closed on any lookup error AND on a thread key
 *  that carries no resolvable channel. */
export function makeAtomAccessChecker(
  web: WebClient,
  now: () => number = () => Date.now(),
  onLog: (msg: string) => void = () => {},
) {
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
      const channel = parseAtomChannel(atom.source?.threadKey ?? "");
      // No resolvable channel → we cannot prove the asker may see this atom, so
      // we do not inject it. Logged (never silently), because the only way this
      // happens in practice is a damaged atom file, and the operator needs the
      // id to repair the front-matter and bring the atom back.
      if (!channel) {
        onLog(
          `atom-access: denied atom ${atom.id} — thread key ${JSON.stringify(
            atom.source?.threadKey ?? "",
          )} names no channel; repair its front-matter to restore retrieval`,
        );
        return false;
      }
      try {
        if (await isPublicChannel(channel)) return true; // open public channel
        return (await members(channel)).has(userId);
      } catch {
        return false; // present-but-unresolvable channel → fail closed
      }
    },
  };
}
