/**
 * The default mocked agent response, shared by the two agent mocks.
 *
 * `test/mocks/claude.ts` (turn-shaped runs) and `test/mocks/oneshot.ts`
 * (machine one-shots) mock two different production modules but must agree on
 * what "no scenario matched" returns, because a lot of suites pin their
 * expectations to `LAZY_MOCK_CLAUDE_RESPONSE` without caring which seam served
 * them. Keeping it in one place stops the two from drifting.
 */

import type { AgentResponse } from '../../src/types';

export function getMockResponse(): AgentResponse {
  const envResponse = process.env.LAZY_MOCK_CLAUDE_RESPONSE;
  if (envResponse) {
    const parsed = JSON.parse(envResponse);
    return {
      result: parsed.result ?? 'Mock Claude response',
      session_id: parsed.session_id ?? 'mock-session-id-' + Date.now(),
      usage: parsed.usage ?? { input_tokens: 100, output_tokens: 200 },
    };
  }
  return {
    result: 'Default mock response',
    session_id: 'mock-session-id-default',
    usage: { input_tokens: 100, output_tokens: 200 },
  };
}
