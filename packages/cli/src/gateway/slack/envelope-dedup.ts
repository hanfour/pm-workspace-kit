/**
 * Slack-side envelope dedup cache. Slack retries any un-acked event
 * up to 3 times within ~30s; this bounded LRU drops dupes so a slow
 * LLM round doesn't get processed twice. Each `SlackAdapter` owns one
 * instance keyed by `envelope_id`.
 *
 * Extracted from `slack/index.ts` in v0.13 as the smallest standalone
 * concern; behaviour is byte-equivalent to the prior inline
 * `seenEnvelopes` / `seenEnvelopeSet` pair + `rememberEnvelope`
 * private method.
 */

/**
 * Default cap. 2 000 entries gives a generous window even on noisy
 * workspaces while keeping memory bounded for long-running hosts.
 */
export const SEEN_ENVELOPES_MAX = 2000;

export class EnvelopeDedup {
  private list: string[] = [];
  private set = new Set<string>();
  private readonly max: number;

  constructor(max: number = SEEN_ENVELOPES_MAX) {
    this.max = max;
  }

  /** Has this envelope been processed already? */
  has(envelopeId: string): boolean {
    return this.set.has(envelopeId);
  }

  /**
   * Record an envelope as processed. Evicts the oldest entry when the
   * LRU is full so memory stays bounded.
   */
  remember(envelopeId: string): void {
    this.set.add(envelopeId);
    this.list.push(envelopeId);
    if (this.list.length > this.max) {
      const evict = this.list.shift();
      if (evict !== undefined) this.set.delete(evict);
    }
  }
}
