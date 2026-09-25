/**
 * Unit tests: runWork refreshes model launch env before retrying after
 * transient_unreachable / daemon-restart stops.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { resolve } from 'path';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { ClaudeCodeAgent } from '../../src/agent/claude-code';
import type { WorkResult } from '../../src/supervisor/work';

const LAUNCH_ENV_PATH = resolve(import.meta.dir, '../../src/supervisor/launch-env.ts');

const MOCK_SUCCESS: WorkResult = {
  result: 'ok',
  session_id: 'sess-retry-refresh',
  usage: { input_tokens: 1, output_tokens: 1 },
};

afterAll(() => {
  restoreMockedModules();
});

describe('runWork launch env refresh on retry', () => {
  test('refreshes supervisor launch env before retrying ConnectionRefused', async () => {
    let refreshCalls = 0;
    await mockModule(LAUNCH_ENV_PATH, () => ({
      refreshSupervisorLaunchEnv: async () => {
        refreshCalls++;
        process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${48000 + refreshCalls}`;
      },
      resolveSupervisorProjectRoot: async () => '/proj',
    }));

    const { runWork, CrashError } = await import('../../src/supervisor/work');
    const agent = new ClaudeCodeAgent();
    let calls = 0;

    const result = await runWork(
      agent,
      {} as never,
      '/tmp/test',
      'prompt',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => {
        calls++;
        if (calls === 1) {
          throw new CrashError({
            message: 'API Error: Unable to connect to API (ConnectionRefused)',
            exitCode: 1,
            stderr: '',
            durationMs: 1,
          });
        }
        return MOCK_SUCCESS;
      },
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => {},
      { taskId: 'aabbccdd-1111-2222-3333-444455556666' },
    );

    expect(result.result).toBe('ok');
    expect(calls).toBe(2);
    expect(refreshCalls).toBe(1);
  });
});
