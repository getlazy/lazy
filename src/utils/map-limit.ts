/**
 * `Array.map` over an async function with at most `limit` calls in flight,
 * results in input order.
 *
 * For store scans that read one small file per task: awaiting them one at a
 * time makes the scan cost N × the filesystem's per-call latency, which is
 * negligible on a local disk and dominant on a network or virtualised mount
 * (a VM's shared folder). Bounded rather than `Promise.all` so a 10k-task store
 * cannot exhaust file descriptors.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** Concurrent reads a store scan keeps in flight. */
export const STORE_SCAN_CONCURRENCY = 32;
