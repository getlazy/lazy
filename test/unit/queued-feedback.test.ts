import { describe, test, expect } from 'bun:test';
import { isHumanFeedbackComment, queuedHumanFeedbackCount } from '../../src/task/queued-feedback';
import type { Comment } from '../../src/storage';

function c(over: Partial<Comment>): Comment {
  return { id: 'c', task_id: 't', content: 'x', created_at: 10, ...over } as Comment;
}

describe('queuedHumanFeedbackCount', () => {
  // INVARIANT: accept refuses on, and every "Before you can accept" surface
  // shows, exactly the feedback a HUMAN queued that no prompt carried. Builder,
  // agent and system comments never count — gating on them would wedge the
  // automations (cluster "[Subtask added]" notes, driver steering) that write
  // them — and neither do comments imported from a forge.
  test('counts undelivered human (and legacy unattributed) comments plus pending review comments', () => {
    const comments = [
      c({ id: 'delivered', actor: 'human', created_at: 5 }),
      c({ id: 'human', actor: 'human' }),
      c({ id: 'legacy' }),
      c({ id: 'builder', actor: 'builder' }),
      c({ id: 'agent', actor: 'agent' }),
      c({ id: 'system', actor: 'system' }),
      c({ id: 'forge', actor: 'human', source: 'remote' }),
    ];
    const n = queuedHumanFeedbackCount({
      session: { notes_delivered_through: 5 },
      turns: [],
      comments,
      pendingReviewComments: 2,
    });
    expect(n).toBe(4);
  });

  test('a person-attributed human actor counts', () => {
    expect(isHumanFeedbackComment(c({ actor: { role: 'human', email: 'a@b' } as never }))).toBe(true);
  });

  // INVARIANT: an accept's own "[Accepted] <reason>" record is a verdict on
  // work that already merged, addressed to nobody — it is not feedback for the
  // agent. Counting it wedged every reopened task: the next accept was refused
  // by the previous accept's own record.
  test('lazy bookkeeping records are not queued feedback; [Reopened]/[Rejected] reasons are', () => {
    for (const content of [
      '[Accepted] ok',
      '[Submitted] Task submitted for review: https://x/pr/1',
      '[Reparented] Parent changed from a to b.',
      '[Re-parented] Stale parent chain detected during sync.',
    ]) {
      expect(isHumanFeedbackComment(c({ actor: 'human', content }))).toBe(false);
    }
    expect(isHumanFeedbackComment(c({ actor: 'human', content: '[Reopened] More work needed' }))).toBe(true);
    expect(isHumanFeedbackComment(c({ actor: 'human', content: '[Rejected] Wrong approach' }))).toBe(true);
  });
});
