import { describe, test, expect } from 'bun:test';
import {
  isTransientAgentBinaryPreflightError,
  preflightAgentBinaryWithRetry,
  PREFLIGHT_RETRY_INTERVAL_MS,
} from '../../src/supervisor/builder';

describe('preflightAgentBinaryWithRetry', () => {
  test('isTransientAgentBinaryPreflightError matches bare-bun selfcheck failures', () => {
    const err = new Error(
      "Builder preflight failed: 'lazy-agent selfcheck' did not identify the lazy agent " +
      '(exit 1, stdout: <no output>, stderr: error: Script not found "selfcheck"). ' +
      'The binary at /usr/local/bin/lazy-agent is a BARE BUN RUNTIME, not the compiled lazy agent',
    );
    expect(isTransientAgentBinaryPreflightError(err)).toBe(true);
  });

  test('isTransientAgentBinaryPreflightError rejects missing-binary exec failures', () => {
    const err = new Error(
      "Builder preflight failed: could not exec 'lazy-agent selfcheck' (ENOENT). " +
      'The lazy-agent binary at /usr/local/bin/lazy-agent appears missing',
    );
    expect(isTransientAgentBinaryPreflightError(err)).toBe(false);
  });

  test('retries transient failures then succeeds', async () => {
    let calls = 0;
    const logs: string[] = [];

    await preflightAgentBinaryWithRetry('lazy-agent', {
      intervalMs: 1,
      totalMs: 50,
      log: (msg) => logs.push(msg),
      preflight: async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error(
            "Builder preflight failed: 'lazy-agent selfcheck' did not identify the lazy agent " +
            '(exit 1, stderr: error: Script not found "selfcheck"). BARE BUN RUNTIME',
          );
        }
      },
    });

    expect(calls).toBe(3);
    expect(logs.length).toBe(2);
    expect(logs[0]).toContain('Agent binary changed mid-read');
    expect(logs[0]).toContain('waiting for the upgrade to finish writing it');
  });

  test('throws after retries exhaust for a persistently bad binary', async () => {
    let calls = 0;
    await expect(
      preflightAgentBinaryWithRetry('lazy-agent', {
        intervalMs: 1,
        totalMs: 5,
        preflight: async () => {
          calls += 1;
          throw new Error(
            "Builder preflight failed: 'lazy-agent selfcheck' did not identify the lazy agent " +
            '(exit 1, stderr: error: Script not found "selfcheck"). BARE BUN RUNTIME',
          );
        },
      }),
    ).rejects.toThrow(/did not identify the lazy agent/);

    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test('does not retry non-transient exec failures', async () => {
    let calls = 0;
    await expect(
      preflightAgentBinaryWithRetry('lazy-agent', {
        intervalMs: 1,
        totalMs: PREFLIGHT_RETRY_INTERVAL_MS,
        preflight: async () => {
          calls += 1;
          throw new Error("Builder preflight failed: could not exec 'lazy-agent selfcheck' (ENOENT)");
        },
      }),
    ).rejects.toThrow(/could not exec/);

    expect(calls).toBe(1);
  });
});
