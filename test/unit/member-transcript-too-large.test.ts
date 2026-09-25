/**
 * INVARIANT: an agent transcript too large to carry into a member's home
 * refuses a member's Pair and Chat — which resume that conversation — with a
 * sentence the member can read, and never refuses their Shell, which does not
 * read it. The member-home half is in test/unit/member-container.test.ts.
 */

import { test, expect } from 'bun:test';
import { taskModeRefusals } from '../../src/daemon/session-attach';

const task = { id: 'task-big-0000-uuid', status: 'blocked', agent_id: 'claude-code', metadata: {} } as never;

test("a member's Pair and Chat are refused for an oversized transcript; their Shell is not", async () => {
  const r = await taskModeRefusals({
    projectRoot: '/p', task, callerEmail: 'alice@example.com', multiMember: true, binary: 'docker',
    deps: {
      holder: () => null,
      runArgsRefusal: async () => null,
      credentialMissing: async () => false,
      pairOrChat: async () => null,
      transcriptTooLarge: async () => true,
    },
  });
  expect(r.refusals.shell).toBeUndefined();
  expect(r.refusals.pair).toContain('too large');
  expect(r.refusals.chat).toContain('Open a Shell instead');
});

test('a transcript of ordinary size refuses nothing', async () => {
  const r = await taskModeRefusals({
    projectRoot: '/p', task, callerEmail: 'alice@example.com', multiMember: true, binary: 'docker',
    deps: {
      holder: () => null,
      runArgsRefusal: async () => null,
      credentialMissing: async () => false,
      pairOrChat: async () => null,
      transcriptTooLarge: async () => false,
    },
  });
  expect(r.refusals).toEqual({});
});
