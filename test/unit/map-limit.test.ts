import { describe, test, expect } from 'bun:test';
import { mapLimit } from '../../src/utils/map-limit';

describe('mapLimit', () => {
  // INVARIANT: store scans overlap their per-file reads (latency-bound on a VM mount)
  // but never exceed the limit, and results keep input order.
  test('bounds concurrency and preserves order', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
    expect(peak).toBe(3);
  });

  test('empty input', async () => {
    expect(await mapLimit([], 4, async (x) => x)).toEqual([]);
  });
});
