/**
 * Test fixtures and convenience helpers
 */

import type { TestContext, MockAgentResponse } from './setup';
import { extractTaskId } from './assertions';

/** Create a task with goal and optional prompt, return the short task ID */
export async function createTask(
  ctx: TestContext,
  goal: string,
  prompt?: string,
): Promise<string> {
  const args = ['create', '--goal', goal];
  if (prompt) {
    args.push('--prompt', prompt);
  }
  const result = await ctx.lazy(args);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create task: ${result.stderr}\n${result.stdout}`);
  }
  return extractTaskId(result.stdout);
}

/** Standard mock response for tests that need Claude to "work" */
export const MOCK_CLAUDE_SUCCESS: MockAgentResponse = {
  result: 'I have completed the task. All changes have been committed.',
  session_id: 'mock-sess-001',
  usage: { input_tokens: 500, output_tokens: 1000 },
};
