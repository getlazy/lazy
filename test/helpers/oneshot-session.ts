/**
 * Build the session JSONL that Claude Code writes for one of lazy's own
 * machine-generated `claude -p` one-shots (a fidelity summary, a `lazy report`
 * unit, an LLM memory compaction).
 *
 * Shape matters: the prompt lazy passes to `claude -p` is journaled VERBATIM as
 * the first user message's content, which is where the one-shot marker lands and
 * where detection looks. Keeping that in one place means a test can't
 * accidentally assert against a shape the real thing never produces.
 */

import { markMachineOneshotPrompt } from '../../src/import/machine-oneshot';

/** A stable session id for the one-shot in tests. */
export const ONESHOT_SESSION = '9e9e9e9e-0000-0000-0000-0000000000ff';

export function oneshotBody(
  sessionId: string,
  cwd: string,
  prompt = 'You are writing the description that will land on this commit.',
): string {
  const lines = [
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      userType: 'external',
      cwd,
      sessionId,
      version: '2.0.0',
      gitBranch: 'main',
      type: 'user',
      uuid: `${sessionId}-u0`,
      timestamp: '2026-07-29T10:00:00Z',
      message: { role: 'user', content: markMachineOneshotPrompt(prompt) },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: `${sessionId}-a0`,
      parentUuid: `${sessionId}-u0`,
      timestamp: '2026-07-29T10:00:05Z',
      sessionId,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Adds the thing and wires it up.' }],
        model: 'claude-opus-4-8',
        usage: { input_tokens: 900, output_tokens: 120 },
      },
    }),
  ];
  return lines.join('\n') + '\n';
}
