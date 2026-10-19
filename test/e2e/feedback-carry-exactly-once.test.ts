/**
 * E2e: feedback an interrupted turn never acted on rides the next unblock
 * exactly once — never nested inside an earlier carry, never repeated after
 * back-to-back interruptions.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { writeFileSync } from 'fs';
import { type StoredTurn, findFullTaskId, readTurns, setTaskStatus, taskFilePath, writeTurns } from '../helpers/storage';

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('unblock carries unconsumed feedback exactly once', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: after T1 ("A") and T2 ("B") are both interrupted, the unblock
  // "C" delivers A and B once each, flat, and leaves only its own turn owed.
  // Carrying every pending turn's composed content nested A inside T2's carry
  // and delivered it twice, growing with every further crash.
  test('back-to-back interruptions never repeat or nest earlier feedback', async () => {
    const shortId = await createTask(ctx, 'Carry once', 'Initial prompt');
    await ctx.lazyMocked(['start', shortId, '--yes'], MOCK_CLAUDE_SUCCESS);
    const taskId = findFullTaskId(ctx.root, shortId);
    // The start turn's prompt is not the subject here: consume it.
    writeTurns(ctx.root, shortId, readTurns(ctx.root, shortId).map(t => (
      t.feedback_delivery === 'pending' ? { ...t, feedback_delivery: 'consumed' } : t)));

    for (const words of ['feedback-AAA', 'feedback-BBB', 'feedback-CCC']) {
      setTaskStatus(ctx.root, taskId, 'interrupted');
      expectSuccess(await ctx.lazyMocked(['unblock', shortId, '--message', words], MOCK_CLAUDE_SUCCESS));
    }

    const human = readTurns(ctx.root, shortId).filter(t => t.role === 'human');
    const last = human[human.length - 1] as unknown as { content: string; feedback_items?: { text: string }[] };
    expect(occurrences(last.content, 'feedback-AAA')).toBe(1);
    expect(occurrences(last.content, 'feedback-BBB')).toBe(1);
    expect(occurrences(last.content, 'feedback-CCC')).toBe(1);
    expect(occurrences(last.content, 'have not acted on yet')).toBe(1);
    expect(last.feedback_items?.map(i => i.text)).toEqual(['feedback-AAA', 'feedback-BBB', 'feedback-CCC']);
    // Only the newest turn still owes anything.
    const pending = human.filter(t => t.feedback_delivery === 'pending');
    expect(pending).toHaveLength(1);
  });

  // INVARIANT: words a refused unblock saved (withheld) ride the next unblock
  // and are then owed by THAT turn alone — if it is interrupted, the following
  // unblock delivers them once, not again from the withheld turn as well.
  test('withheld feedback is delivered once even after the carrying turn is interrupted', async () => {
    const shortId = await createTask(ctx, 'Withheld once', 'Initial prompt');
    await ctx.lazyMocked(['start', shortId, '--yes'], MOCK_CLAUDE_SUCCESS);
    const taskId = findFullTaskId(ctx.root, shortId);
    const turns = readTurns(ctx.root, shortId).map(t => (
      t.feedback_delivery === 'pending' ? { ...t, feedback_delivery: 'consumed' } : t));
    const last = turns[turns.length - 1];
    writeTurns(ctx.root, shortId, [...turns, {
      ...last, id: `${last.id as string}-w`, sequence: (last.sequence ?? 0) + 1, role: 'human',
      content: 'withheld-WWW', actor: 'human', actor_email: 'w@example.com', actor_name: 'Wanda',
      feedback_delivery: 'pending', feedback_withheld: true,
    }]);

    for (const words of ['feedback-BBB', 'feedback-CCC']) {
      setTaskStatus(ctx.root, taskId, 'interrupted');
      expectSuccess(await ctx.lazyMocked(['unblock', shortId, '--message', words], MOCK_CLAUDE_SUCCESS));
    }

    const human = readTurns(ctx.root, shortId).filter(t => t.role === 'human');
    const final = human[human.length - 1];
    expect(occurrences(final.content as string, 'withheld-WWW')).toBe(1);
    expect(occurrences(final.content as string, 'Wanda <w@example.com>')).toBe(1);
    expect(human.filter(t => t.feedback_withheld)).toHaveLength(0);
    expect(human.filter(t => t.feedback_delivery === 'pending')).toHaveLength(1);
  });

  // INVARIANT: withheld words were never delivered, so a completed turn in
  // between (an ask, say) that marked the session's feedback consumed must not
  // make the next unblock skip them — they are owed until a turn carries them.
  test('withheld feedback a completed turn marked consumed is still carried once', async () => {
    const shortId = await createTask(ctx, 'Withheld after ask', 'Initial prompt');
    await ctx.lazyMocked(['start', shortId, '--yes'], MOCK_CLAUDE_SUCCESS);
    const taskId = findFullTaskId(ctx.root, shortId);
    const turns: StoredTurn[] = readTurns(ctx.root, shortId).map(t => ({ ...t, feedback_delivery: 'consumed' }));
    const last = turns[turns.length - 1];
    writeTurns(ctx.root, shortId, [...turns, {
      ...last, id: `${last.id as string}-w`, sequence: (last.sequence ?? 0) + 1, role: 'human',
      content: 'withheld-WWW', actor: 'human', feedback_delivery: 'consumed', feedback_withheld: true,
    }]);

    setTaskStatus(ctx.root, taskId, 'interrupted');
    expectSuccess(await ctx.lazyMocked(['unblock', shortId, '--message', 'feedback-BBB'], MOCK_CLAUDE_SUCCESS));

    const human = readTurns(ctx.root, shortId).filter(t => t.role === 'human');
    expect(occurrences(human[human.length - 1].content as string, 'withheld-WWW')).toBe(1);
    expect(human.filter(t => t.feedback_withheld)).toHaveLength(0);
  });

  // INVARIANT: review comments an interrupted turn delivered (and marked
  // delivered) ride the next unblock's carry, once — the carry is their only
  // route back to the agent.
  test('review comments delivered with an interrupted turn are carried once', async () => {
    const shortId = await createTask(ctx, 'Comments carried', 'Initial prompt');
    await ctx.lazyMocked(['start', shortId, '--yes'], MOCK_CLAUDE_SUCCESS);
    const taskId = findFullTaskId(ctx.root, shortId);
    writeTurns(ctx.root, shortId, readTurns(ctx.root, shortId).map(t => ({ ...t, feedback_delivery: 'consumed' })));
    writeFileSync(taskFilePath(ctx.root, shortId, 'review-comments.json'), JSON.stringify({ review_comments: [{
      id: 'rc-1', task_id: taskId, thread_id: 'rc-1', file: 'src/foo.ts', line: 4, side: 'new', role: 'human',
      content: 'COMMENT-QQQ rename this helper', created_at: Date.now(), actor: 'human', intent: 'comment',
      delivery_state: 'pending_delivery', anchor_snippet: '+line 4',
    }] }));

    for (const words of ['feedback-BBB', 'feedback-CCC']) {
      setTaskStatus(ctx.root, taskId, 'interrupted');
      expectSuccess(await ctx.lazyMocked(['unblock', shortId, '--message', words], MOCK_CLAUDE_SUCCESS));
    }

    const human = readTurns(ctx.root, shortId).filter(t => t.role === 'human');
    const final = human[human.length - 1].content as string;
    expect(occurrences(final, 'COMMENT-QQQ')).toBe(1);
    expect(occurrences(final, 'feedback-BBB')).toBe(1);
  });
});
