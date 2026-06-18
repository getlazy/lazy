/**
 * Unit tests for 'Prompt is too long' handling in supervisor work phase.
 *
 * Uses the _executeOverride parameter to inject a mock executor,
 * allowing us to test the retry logic without spawning real processes.
 */

import { describe, test, expect } from 'bun:test';
import { runWork, CrashError, type WorkResult, type RetryState } from '../../src/supervisor/work';
import { ClaudeCodeAgent } from '../../src/agent/claude-code';
import { createRunnerFromType } from '../../src/runner';

const agent = new ClaudeCodeAgent();
// These tests inject _executeOverride, so the runner is never consulted for
// session-log discovery — any runner instance satisfies the signature.
const runner = createRunnerFromType('dangerously-host-process-without-any-isolation');

const MOCK_SUCCESS: WorkResult = {
  result: 'Task completed successfully',
  session_id: 'new-session-abc123',
  usage: { input_tokens: 100, output_tokens: 200 },
};

function makeCrashError(message: string): CrashError {
  return new CrashError({
    message,
    exitCode: 1,
    stderr: message,
    stdoutError: message,
    durationMs: 500,
  });
}

describe('isPromptTooLongError', () => {
  test('detects exact "Prompt is too long" message', () => {
    expect(agent.isPromptTooLongError('Prompt is too long')).toBe(true);
  });

  test('detects message containing "Prompt is too long"', () => {
    expect(agent.isPromptTooLongError('Error: Prompt is too long (max 200000 tokens)')).toBe(true);
  });

  test('does not match unrelated errors', () => {
    expect(agent.isPromptTooLongError('Connection reset')).toBe(false);
    expect(agent.isPromptTooLongError('Rate limited')).toBe(false);
    expect(agent.isPromptTooLongError('prompt too long')).toBe(false); // case-sensitive
  });
});

describe('runWork prompt-too-long handling', () => {
  test('clears session and retries fresh when resuming hits prompt-too-long', async () => {
    const calls: { sessionId: string | undefined }[] = [];
    let callCount = 0;

    const mockExecute = async (
      _worktreePath: string,
      _prompt: string,
      _systemPrompt?: string,
      _modelId?: string,
      claudeSessionId?: string,
    ): Promise<WorkResult> => {
      calls.push({ sessionId: claudeSessionId });
      callCount++;

      if (callCount === 1) {
        // First call with session ID — fail with prompt too long
        throw makeCrashError('Prompt is too long');
      }

      // Second call without session ID — succeed
      return MOCK_SUCCESS;
    };

    const retryStates: (RetryState | null)[] = [];
    const result = await runWork(
      agent,
      runner,
      '/tmp/test',
      'Do the work',
      undefined,  // systemPrompt
      undefined,  // modelId
      'old-session-id-123',  // claudeSessionId
      undefined,  // protocolDir
      (state) => retryStates.push(state ? { ...state } : null),  // onRetryStateChange
      mockExecute,  // _executeOverride
    );

    // Should have made exactly 2 calls
    expect(calls).toHaveLength(2);
    // First call had the session ID
    expect(calls[0].sessionId).toBe('old-session-id-123');
    // Second call had no session ID (cleared)
    expect(calls[1].sessionId).toBeUndefined();
    // Should return the successful result
    expect(result).toEqual(MOCK_SUCCESS);
    // Should have notified about retry state then cleared it
    expect(retryStates).toHaveLength(2);
    expect(retryStates[0]).not.toBeNull();
    expect(retryStates[0]!.count).toBe(1);
    expect(retryStates[1]).toBeNull(); // success clears retry state
  });

  test('gives up when fresh session also hits prompt-too-long', async () => {
    const calls: { sessionId: string | undefined }[] = [];

    const mockExecute = async (
      _worktreePath: string,
      _prompt: string,
      _systemPrompt?: string,
      _modelId?: string,
      claudeSessionId?: string,
    ): Promise<WorkResult> => {
      calls.push({ sessionId: claudeSessionId });
      throw makeCrashError('Prompt is too long');
    };

    await expect(
      runWork(
        agent,
        runner,
        '/tmp/test',
        'Do the work',
        undefined,  // systemPrompt
        undefined,  // modelId
        'old-session-id-123',  // claudeSessionId
        undefined,  // protocolDir
        undefined,  // onRetryStateChange
        mockExecute,  // _executeOverride
      ),
    ).rejects.toThrow('Prompt is too long even without session resume');

    // Call 1: with session → prompt too long → clear session, immediate retry
    // Call 2: without session → prompt too long → no session to clear → throw
    expect(calls).toHaveLength(2);
    expect(calls[0].sessionId).toBe('old-session-id-123');
    expect(calls[1].sessionId).toBeUndefined();
  });

  test('does not count prompt-too-long as fast-fail for crash loop detection', async () => {
    let callCount = 0;

    const mockExecute = async (
      _worktreePath: string,
      _prompt: string,
      _systemPrompt?: string,
      _modelId?: string,
      claudeSessionId?: string,
    ): Promise<WorkResult> => {
      callCount++;

      if (callCount === 1) {
        throw makeCrashError('Prompt is too long');
      }

      return MOCK_SUCCESS;
    };

    const retryStates: (RetryState | null)[] = [];
    const result = await runWork(
      agent,
      runner,
      '/tmp/test',
      'Do the work',
      undefined,  // systemPrompt
      undefined,  // modelId
      'session-123',  // claudeSessionId
      undefined,  // protocolDir
      (state) => retryStates.push(state ? { ...state } : null),  // onRetryStateChange
      mockExecute,  // _executeOverride
    );

    expect(result).toEqual(MOCK_SUCCESS);
    // The retry state should show consecutiveFastFails was reset to 0
    expect(retryStates[0]!.consecutiveFastFails).toBe(0);
  });

  test('records prompt-too-long error in retry state errors', async () => {
    let callCount = 0;

    const mockExecute = async (
      _worktreePath: string,
      _prompt: string,
      _systemPrompt?: string,
      _modelId?: string,
      _claudeSessionId?: string,
    ): Promise<WorkResult> => {
      callCount++;
      if (callCount === 1) {
        throw makeCrashError('Prompt is too long');
      }
      return MOCK_SUCCESS;
    };

    const retryStates: (RetryState | null)[] = [];
    await runWork(
      agent,
      runner,
      '/tmp/test',
      'Do the work',
      undefined,  // systemPrompt
      undefined,  // modelId
      'session-123',  // claudeSessionId
      undefined,  // protocolDir
      (state) => retryStates.push(state ? { ...state, errors: [...state.errors] } : null),  // onRetryStateChange
      mockExecute,  // _executeOverride
    );

    // Check that the error was recorded
    expect(retryStates[0]!.errors).toHaveLength(1);
    expect(retryStates[0]!.errors[0].message).toBe('Prompt is too long');
  });

  test('retries immediately without backoff when clearing session', async () => {
    const callTimestamps: number[] = [];
    let callCount = 0;

    const mockExecute = async (
      _worktreePath: string,
      _prompt: string,
      _systemPrompt?: string,
      _modelId?: string,
      _claudeSessionId?: string,
    ): Promise<WorkResult> => {
      callTimestamps.push(Date.now());
      callCount++;

      if (callCount === 1) {
        throw makeCrashError('Prompt is too long');
      }

      return MOCK_SUCCESS;
    };

    await runWork(
      agent,
      runner,
      '/tmp/test',
      'Do the work',
      undefined,  // systemPrompt
      undefined,  // modelId
      'session-123',  // claudeSessionId
      undefined,  // protocolDir
      undefined,  // onRetryStateChange
      mockExecute,  // _executeOverride
    );

    // The retry should be immediate (no 30s backoff)
    const timeBetweenCalls = callTimestamps[1] - callTimestamps[0];
    expect(timeBetweenCalls).toBeLessThan(1000); // well under the 30s minimum backoff
  });

  test('fails immediately when no session was provided and prompt is too long', async () => {
    let callCount = 0;

    const mockExecute = async (
      _worktreePath: string,
      _prompt: string,
      _systemPrompt?: string,
      _modelId?: string,
      _claudeSessionId?: string,
    ): Promise<WorkResult> => {
      callCount++;
      throw makeCrashError('Prompt is too long');
    };

    // When there's no session to clear, should fail immediately (no retry)
    await expect(
      runWork(
        agent,
        runner,
        '/tmp/test',
        'Do the work',
        undefined,  // systemPrompt
        undefined,  // modelId
        undefined,  // claudeSessionId (no session)
        undefined,  // protocolDir
        undefined,  // onRetryStateChange
        mockExecute,  // _executeOverride
      ),
    ).rejects.toThrow('Prompt is too long even without session resume');

    // Only one call — no point retrying since the prompt won't get shorter
    expect(callCount).toBe(1);
  });
});
