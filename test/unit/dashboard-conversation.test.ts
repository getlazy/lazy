import { describe, expect, test } from 'bun:test';
import type { Task, Turn } from '../../src/types';
import { latestExchangeHtml, taskTurnsSectionHtml } from '../../src/server/templates';
import { SUPERVISED_HEADINGS } from '../../src/task/supervised-headings';
import { supervisedTurnContent } from '../../src/task/wrapper-fold';

let seq = 0;
function turn(partial: Partial<Turn>): Turn {
  seq += 1;
  return {
    id: `t${seq}`, session_id: 's', sequence: seq, role: 'agent', content: `body ${seq}`,
    timestamp: 1_700_000_000_000 + seq * 1000, usage: null,
    start_sha: null, start_sha_work: null, end_sha_work: null, end_sha: null, ...partial,
  } as Turn;
}

const task = { id: 'abcdef12-0000-0000-0000-000000000000', code: 'conv', goal: 'g', status: 'blocked' } as unknown as Task;

function scenario(): Turn[] {
  seq = 0;
  return [
    turn({ role: 'human', actor: 'human', content: 'Please add the export.' }),
    turn({ role: 'agent', content: 'Export added.' }),
    // A wrap-up step exactly as the reconciler records it: a supervisor nudge
    // pair whose prompt carries the kind's heading.
    turn({ role: 'human', actor: 'supervisor', auto_triggered: true, turn_type: 'nudge',
      content: supervisedTurnContent('maintain', SUPERVISED_HEADINGS.maintain, 'Update CHANGELOG.') }),
    turn({ role: 'agent', turn_type: 'nudge', content: 'CHANGELOG done.' }),
  ];
}

describe('dashboard conversation view', () => {
  // INVARIANT: the conversation view folds mechanical turns into a closed
  // drawer — every one still rendered — and puts the reply after them.
  test('Turns tab: prompt, folded mechanical turns, then reply', () => {
    const html = taskTurnsSectionHtml(task, null, scenario(), 'newest', { view: 'conversation' });
    const drawer = html.match(/<details class="conversation-mechanical" data-mechanical><summary>([^<]*)<\/summary>([\s\S]*?)<\/details><div class="conversation-reply"/);
    expect(drawer).not.toBeNull();
    expect(drawer![1]).toBe('2 mechanical turns: wrap-up');
    expect(drawer![2]).toContain('id="turn-3"');
    expect(drawer![2]).toContain('id="turn-4"');
    const reply = html.slice(html.indexOf('data-reply>'));
    expect(reply).toContain('id="turn-2"');
    expect(html).toContain('id="chunk-1"');
    expect(html).toContain('turns?view=chunks');
  });

  // INVARIANT: a comment handed to the running turn is shown open with its
  // answer, never folded with lazy's own turns.
  test('a mid-turn comment is an open follow-up', () => {
    const turns = [...scenario(),
      turn({ role: 'human', actor: 'supervisor', auto_triggered: true, turn_type: 'nudge',
        content: supervisedTurnContent('pending_notes', SUPERVISED_HEADINGS.pending_notes, 'Also handle empty input.') }),
      turn({ role: 'agent', turn_type: 'nudge', content: 'Handled.' })];
    const html = taskTurnsSectionHtml(task, null, turns, 'newest', { view: 'conversation' });
    const followUp = html.match(/<div class="conversation-follow-up" data-follow-up>([\s\S]*?)<details class="conversation-mechanical"/);
    expect(followUp).not.toBeNull();
    expect(followUp![1]).toContain('id="turn-5"');
    expect(followUp![1]).toContain('id="turn-6"');
  });

  test('view=chunks keeps the raw chunk view', () => {
    const html = taskTurnsSectionHtml(task, null, scenario(), 'newest', { view: 'chunks' });
    expect(html).not.toContain('data-mechanical');
    expect(html).toContain('Conversation</a>');
  });

  // INVARIANT: the answer lands where the question was asked — Current review
  // carries the latest exchange with its reply.
  test('latest exchange for Current review', () => {
    const turns = [...scenario(), turn({ role: 'human', actor: 'human', turn_type: 'ask', content: 'Why?' }),
      turn({ role: 'agent', turn_type: 'ask', content: 'Because.' })];
    const html = latestExchangeHtml(task, null, turns);
    expect(html).toContain('id="latest-exchange"');
    expect(html).toContain('id="turn-5"');
    expect(html.slice(html.indexOf('data-reply>'))).toContain('id="turn-6"');
    expect(latestExchangeHtml(task, null, [])).toBe('');
  });
});
