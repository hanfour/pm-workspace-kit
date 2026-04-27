/**
 * Run `items` through `worker` with at most `limit` in flight at once.
 * Preserves input order in the output array. No external deps.
 */
export async function pLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  // NaN / Infinity / negative all fall back to 1. A silent pass-through
  // of NaN would give `Array.from({ length: NaN }) === []`, meaning
  // zero runners spawn and every task is skipped — results would be
  // an undefined-filled array the same length as `items`, which is the
  // worst kind of silent failure.
  const size = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runners = Array.from(
    { length: Math.min(size, items.length) },
    async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    },
  );

  await Promise.all(runners);
  return results;
}
