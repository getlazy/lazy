import { describe, test, expect } from 'bun:test';
import { withRemoteRetry } from '../../src/utils/retry';

// INVARIANT: Remote operations must retry with progressive backoff.
// If all attempts fail, the operation FAILS — no silent fallback.
describe('withRemoteRetry', () => {
  test('returns result on first success', async () => {
    const result = await withRemoteRetry(
      async () => 'ok',
      'test operation',
      { backoffMs: [10, 20] },
    );
    expect(result).toBe('ok');
  });

  test('retries on failure and succeeds on second attempt', async () => {
    let attempts = 0;
    const result = await withRemoteRetry(
      async () => {
        attempts++;
        if (attempts === 1) throw new Error('transient');
        return 'ok';
      },
      'test operation',
      { backoffMs: [10, 20] },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  test('retries up to maxAttempts then throws', async () => {
    let attempts = 0;
    await expect(
      withRemoteRetry(
        async () => {
          attempts++;
          throw new Error('permanent failure');
        },
        'push main',
        { maxAttempts: 3, backoffMs: [10, 20] },
      ),
    ).rejects.toThrow('push main failed after 3 attempts');
    expect(attempts).toBe(3);
  });

  // INVARIANT: Error message must tell user what happened and what to do.
  test('error message includes last error and recovery instructions', async () => {
    try {
      await withRemoteRetry(
        async () => { throw new Error('Connection refused'); },
        'fetch branch feature',
        { maxAttempts: 2, backoffMs: [10] },
      );
      expect(true).toBe(false); // Should not reach here
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('fetch branch feature failed after 2 attempts');
      expect(message).toContain('Connection refused');
      expect(message).toContain('Check your network connection');
    }
  });

  test('calls onRetry callback between attempts', async () => {
    const retries: number[] = [];
    let attempts = 0;
    await withRemoteRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error('fail');
        return 'ok';
      },
      'test',
      {
        maxAttempts: 3,
        backoffMs: [10, 20],
        onRetry: (attempt) => retries.push(attempt),
      },
    );
    expect(retries).toEqual([1, 2]);
  });

  // INVARIANT: offlineOverride skips the operation entirely — never silently succeeds.
  test('offlineOverride throws immediately without attempting', async () => {
    let attempts = 0;
    await expect(
      withRemoteRetry(
        async () => { attempts++; return 'ok'; },
        'push main',
        { offlineOverride: true },
      ),
    ).rejects.toThrow('offline override');
    expect(attempts).toBe(0);
  });
});
