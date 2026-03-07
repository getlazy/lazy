/**
 * Unit tests for watchdog integration with runWork.
 *
 * Tests that WatchdogTimeoutError is treated as non-retriable — the supervisor
 * should NOT retry after a watchdog kill, because the agent is hung and retrying
 * would likely hang again.
 */

import { describe, test, expect } from 'bun:test';
import { runWork, type WorkResult, type RetryState } from '../../src/supervisor/work';
import { WatchdogTimeoutError } from '../../src/supervisor/watchdog';
import { ClaudeCodeAgent } from '../../src/agent/claude-code';

const agent = new ClaudeCodeAgent();

const MOCK_SUCCESS: WorkResult = {
  result: 'Task completed successfully',
  session_id: 'new-session-abc123',
  usage: { input_tokens: 100, output_tokens: 200 },
};

// INVARIANT: Watchdog kills are never retried. A hung agent will hang again.
// This differs from CrashError which gets exponential backoff retries.
describe('runWork watchdog handling', () => {
  test('does not retry on WatchdogTimeoutError', async () => {
    let callCount = 0;

    const mockExecute = async (): Promise<WorkResult> => {
      callCount++;
      throw new WatchdogTimeoutError(30000, 45000);
    };

    await expect(
      runWork(
        agent,
        '/tmp/test',
        'Do the work',
        undefined,  // systemPrompt
        undefined,  // modelId
        undefined,  // claudeSessionId
        undefined,  // protocolDir
        undefined,  // onRetryStateChange
        mockExecute,
      ),
    ).rejects.toThrow('Agent process killed by watchdog (no output for 30s)');

    // Should have made exactly 1 call — no retries
    expect(callCount).toBe(1);
  });

  test('WatchdogTimeoutError propagates even when session ID is present', async () => {
    let callCount = 0;

    const mockExecute = async (): Promise<WorkResult> => {
      callCount++;
      throw new WatchdogTimeoutError(30000, 45000);
    };

    await expect(
      runWork(
        agent,
        '/tmp/test',
        'Do the work',
        undefined,
        undefined,
        'session-123',  // claudeSessionId
        undefined,
        undefined,
        mockExecute,
      ),
    ).rejects.toThrow('Agent process killed by watchdog');

    expect(callCount).toBe(1);
  });

  test('error metadata is preserved on WatchdogTimeoutError', async () => {
    const mockExecute = async (): Promise<WorkResult> => {
      throw new WatchdogTimeoutError(30000, 45000);
    };

    try {
      await runWork(agent, '/tmp/test', 'Do the work', undefined, undefined, undefined, undefined, undefined, mockExecute);
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(WatchdogTimeoutError);
      const watchdogErr = err as WatchdogTimeoutError;
      expect(watchdogErr.timeoutMs).toBe(30000);
      expect(watchdogErr.durationMs).toBe(45000);
    }
  });
});
