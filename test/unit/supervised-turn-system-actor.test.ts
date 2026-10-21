/**
 * The wrap-up follow-ups of a turn nobody asked for (an auto-resume, an
 * auto-deliver) are the system's, like the work turn they follow.
 */

import { test, expect } from 'bun:test';
import { recordSupervisedTurns } from '../../src/utils/reconcile';
import type { CompletedResponse } from '../../src/protocol';

function storage() {
  const turns: Array<Record<string, unknown>> = [];
  let seq = 0;
  return {
    turns,
    getNextTurnSequence: async () => ++seq,
    createTurn: async (params: Record<string, unknown>) => { turns.push(params); return params; },
  };
}

const present = {
  status: 'completed',
  result: 'declared the presentation',
  session_id: 'sess',
  usage: { input_tokens: 0, output_tokens: 0 },
  supervised: { kind: 'present', prompt: 'present it' },
} as unknown as CompletedResponse;

// INVARIANT: a supervised reply in a system-initiated turn records the
// configured system identity under the role `system`, exactly as the work turn
// beside it does (AGENTS.md, "Work nobody asked for"). Recording it with no
// actor made one turn's rows disagree about who did the work.
test('a system-initiated turn\'s wrap-up reply is the system\'s', async () => {
  const s = storage();
  await recordSupervisedTurns(s as never, 'sess', [present], '/tmp/wt',
    { email: 'ops@example.com', name: 'Ops', system: true });
  const reply = s.turns.find((t) => t.role === 'agent');
  expect(reply?.actor).toEqual({ role: 'system', email: 'ops@example.com', name: 'Ops' });
});

test('a turn somebody asked for keeps the agent channel and names them', async () => {
  const s = storage();
  await recordSupervisedTurns(s as never, 'sess', [present], '/tmp/wt',
    { email: 'alice@example.com', system: false });
  expect(s.turns.find((t) => t.role === 'agent')?.actor).toEqual({ role: 'agent', email: 'alice@example.com' });
});
