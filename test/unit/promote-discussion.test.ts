/**
 * Seeding a task from a review discussion.
 *
 * What a promoted task SAYS is the whole value of the feature: the reviewer
 * edits it, but they edit what was seeded, and a seeded prompt that lost the
 * agent's own explanation is a task nobody can act on.
 */

import { describe, test, expect } from 'bun:test';
import {
  buildDiscussionTaskPrompt,
  defaultDiscussionGoal,
  discussionQuestion,
} from '../../src/review/promote-discussion';
import type { ReviewComment, Task } from '../../src/types';
import { threadHtml, type Thread } from '../../src/server/review';

const task = {
  id: 'abcdef0123456789',
  code: 'fix-retries',
  goal: 'Bound the retry path',
  status: 'complete',
} as unknown as Task;

function msg(role: 'human' | 'agent', content: string, over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: over.id ?? `${role}-1`,
    task_id: task.id,
    thread_id: 'thread-1',
    file: '(task)',
    line: 0,
    side: 'new',
    role,
    content,
    created_at: 1,
    ...over,
  } as ReviewComment;
}

describe('promote a discussion', () => {
  const thread = [
    msg('human', 'Why is the retry path unbounded? It looks like it can spin forever.'),
    msg('agent', 'It inherits the caller timeout. Bounding it needs a budget on the queue, which was out of scope.'),
  ];

  test('the goal comes from the reviewer\'s own question, not the answer', () => {
    const goal = defaultDiscussionGoal(thread, task);
    expect(goal).toContain('Why is the retry path unbounded');
    expect(goal).not.toContain('caller timeout');
  });

  test('an unusably short question falls back to the task it came from', () => {
    const goal = defaultDiscussionGoal([msg('human', 'Why?'), thread[1]], task);
    expect(goal).toContain('Bound the retry path');
  });

  // The whole exchange, verbatim: the agent's own words about its own work are
  // the best prompt material there is, and a summary here would lose exactly
  // the detail the promotion exists to keep.
  test('the prompt carries the whole exchange plus provenance', () => {
    const prompt = buildDiscussionTaskPrompt(thread, task);
    expect(prompt).toContain('Why is the retry path unbounded?');
    expect(prompt).toContain('budget on the queue');
    expect(prompt).toContain('Promoted from a review discussion on task fix-retries');
    expect(prompt).toContain('Bound the retry path');
  });

  // INVARIANT: a withdrawn message is retracted, so it must not become part of
  // somebody's brief.
  test('withdrawn messages are left out of the seeded prompt', () => {
    const withWithdrawn = [
      msg('human', 'Ignore this, wrong thread', { id: 'human-0', withdrawn_at: 5 }),
      ...thread,
    ];
    const prompt = buildDiscussionTaskPrompt(withWithdrawn, task);
    expect(prompt).not.toContain('wrong thread');
    expect(prompt).toContain('Why is the retry path unbounded?');
    expect(discussionQuestion(withWithdrawn)?.content).toContain('Why is the retry path unbounded');
  });
});

/**
 * Where the Promote form POSTS to.
 *
 * INVARIANT: the promote target is the DUP-AWARE segment. A code two tasks
 * share resolves to whichever one the resolver names the winner, so a form
 * posting to `/tasks/<shared-code>/review/thread/…/promote` would seed the new
 * task from a DIFFERENT task's thread — or 404 when the winner has no such
 * thread. Every other link in this UI falls back to the id for a shared code;
 * this one is a WRITE, so it is the one that must not guess.
 */
describe('the Promote form target', () => {
  const dupTask = {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    code: 'shared-code',
    goal: 'Bound the retry path',
    status: 'blocked',
  } as unknown as Task;

  const thread: Thread = {
    threadId: 'thread-1',
    file: '(task)',
    line: 0,
    side: 'new',
    messages: [
      { ...msg('human', 'Why is the retry path unbounded?'), task_id: dupTask.id, id: 'thread-1' },
      { ...msg('agent', 'It inherits the caller timeout.'), task_id: dupTask.id },
    ],
  };

  const promoteAction = (html: string): string | undefined =>
    html.match(/<form method="post" action="([^"]*\/promote)"/)?.[1];

  test('falls back to the id when another task shares the code', () => {
    const html = threadHtml('irrelevant-render-seg', thread, {
      taskLevel: true,
      promoteFor: dupTask,
      duplicatedCodes: new Set(['shared-code']),
    });
    expect(promoteAction(html)).toBe(
      `/tasks/${dupTask.id}/review/thread/thread-1/promote`,
    );
    // The ambiguous spelling must not be the target of a write.
    expect(promoteAction(html)).not.toContain('shared-code');
  });

  test('uses the code when it is unique — the ordinary case is unchanged', () => {
    const html = threadHtml('irrelevant-render-seg', thread, {
      taskLevel: true,
      promoteFor: dupTask,
      duplicatedCodes: new Set(['some-other-code']),
    });
    expect(promoteAction(html)).toBe('/tasks/shared-code/review/thread/thread-1/promote');
  });

  // No set is not the same as an empty set, but both mean "nothing known to be
  // shared" — the code is correct whenever it is unique, which is the ordinary
  // case, and this keeps a caller that cannot build a set from losing codes.
  test('uses the code when the caller supplies no set at all', () => {
    const html = threadHtml('irrelevant-render-seg', thread, {
      taskLevel: true,
      promoteFor: dupTask,
    });
    expect(promoteAction(html)).toBe('/tasks/shared-code/review/thread/thread-1/promote');
  });
});
