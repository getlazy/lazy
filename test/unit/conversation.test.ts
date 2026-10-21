import { describe, expect, test } from 'bun:test';
import type { Turn } from '../../src/types';
import { buildConversation } from '../../src/task/conversation';
import { parseShowSections } from '../../src/task/show-sections';
import { SUPERVISED_HEADINGS } from '../../src/task/supervised-headings';
import { supervisedTurnContent } from '../../src/task/wrapper-fold';
import type { SupervisedKind } from '../../src/protocol/types';

let seq = 0;
function turn(partial: Partial<Turn>): Turn {
  seq += 1;
  return {
    id: `t${seq}`, session_id: 's', sequence: seq, role: 'agent', content: 'x', timestamp: seq,
    usage: null, start_sha: null, start_sha_work: null, end_sha_work: null, end_sha: null,
    ...partial,
  } as Turn;
}

/**
 * A supervised follow-up exactly as the reconciler records it
 * (recordSupervisedTurns): a supervisor `nudge` prompt carrying the kind's
 * heading, then the agent's `nudge` reply.
 */
function supervisedPair(kind: SupervisedKind, prompt = 'do the thing', reply = 'done'): Turn[] {
  return [
    turn({ role: 'human', actor: 'supervisor', auto_triggered: true, turn_type: 'nudge',
      content: supervisedTurnContent(kind, SUPERVISED_HEADINGS[kind], prompt) }),
    turn({ role: 'agent', turn_type: 'nudge', content: reply }),
  ];
}

describe('buildConversation', () => {
  // INVARIANT: an exchange pairs the person's message with the agent's reply to
  // it, and every mechanical turn between them is LISTED, never dropped. The
  // conversation view collapses supervisor<->agent back-and-forth; a turn that
  // vanished from it would be hidden for good.
  test('pairs the prompt with the work reply and labels recorded follow-ups by kind', () => {
    seq = 0;
    const turns = [
      turn({ role: 'human', actor: 'human', content: 'do it' }),               // 1 prompt
      turn({ role: 'agent', content: 'did it' }),                              // 2 reply
      ...supervisedPair('commit_nudge'),                                       // 3, 4
      ...supervisedPair('low_high_review'),                                    // 5, 6
      turn({ role: 'agent', turn_type: 'review', review_dispatch: 'self' }),   // 7
      ...supervisedPair('maintain'),                                           // 8, 9
      turn({ role: 'human', actor: 'supervisor', auto_triggered: true, turn_type: 'sync' }), // 10
    ];
    const [ex] = buildConversation(turns);
    expect(ex!.prompt_sequence).toBe(1);
    expect(ex!.reply_sequence).toBe(2);
    expect(ex!.follow_ups).toEqual([]);
    expect(ex!.mechanical.map((m) => [m.sequence, m.kind])).toEqual([
      [3, 'nudge'], [4, 'nudge'],
      [5, 'self-review'], [6, 'self-review'], [7, 'self-review'],
      [8, 'wrap-up'], [9, 'wrap-up'],
      [10, 'sync'],
    ]);
    expect(ex!.mechanical_label).toBe('8 mechanical turns: nudge, self-review, wrap-up, sync');
  });

  // INVARIANT: a comment handed to the running turn is a person's message, not
  // lazy's — it and the agent's answer are a FOLLOW-UP shown open, never folded
  // into the mechanical drawer.
  test('a mid-turn comment and its answer are a follow-up, not mechanical', () => {
    seq = 0;
    const turns = [
      turn({ role: 'human', actor: 'human', content: 'do it' }),
      turn({ role: 'agent', content: 'working' }),
      ...supervisedPair('pending_notes', 'Also handle empty input.', 'Handled.'),
      ...supervisedPair('present'),
    ];
    const [ex] = buildConversation(turns);
    expect(ex!.reply_sequence).toBe(2);
    expect(ex!.follow_ups).toEqual([{ prompt_sequence: 3, reply_sequence: 4 }]);
    expect(ex!.mechanical.map((m) => m.sequence)).toEqual([5, 6]);
    expect(ex!.mechanical_label).toBe('2 mechanical turns: wrap-up');
  });

  test('the reply is the LAST work turn, earlier work turns are agent steps', () => {
    seq = 0;
    const turns = [
      turn({ role: 'human', actor: 'builder' }),
      turn({ role: 'agent', content: 'first' }),
      turn({ role: 'human', actor: 'system', auto_triggered: true }),
      turn({ role: 'agent', content: 'final' }),
    ];
    const [ex] = buildConversation(turns);
    expect(ex!.reply_sequence).toBe(4);
    expect(ex!.mechanical).toEqual([{ sequence: 2, kind: 'agent step' }, { sequence: 3, kind: 'resume' }]);
  });

  test('one exchange per human action; an ask is answered by its ask reply', () => {
    seq = 0;
    const turns = [
      turn({ role: 'human', actor: 'human' }),
      turn({ role: 'agent' }),
      turn({ role: 'human', actor: 'human', turn_type: 'ask' }),
      turn({ role: 'agent', turn_type: 'ask', content: 'answer' }),
    ];
    const exchanges = buildConversation(turns);
    expect(exchanges.map((e) => [e.prompt_sequence, e.reply_sequence])).toEqual([[1, 2], [3, 4]]);
    expect(exchanges[1]!.mechanical_label).toBeNull();
  });

  test('no reply yet, recovered turns, and a leading automation run', () => {
    seq = 0;
    const turns = [
      turn({ role: 'agent', content: '[Recovered] The supervisor never finalized this turn' }),
      turn({ role: 'human', actor: 'human' }),
    ];
    const [lead, open] = buildConversation(turns);
    expect(lead!.prompt_sequence).toBeNull();
    expect(lead!.reply_sequence).toBe(1);
    expect(open!.reply_sequence).toBeNull();
    // Only-mechanical agent turns: the last one is still what came back.
    seq = 0;
    const [ex] = buildConversation([turn({ role: 'human', actor: 'human' }), turn({ role: 'agent', turn_type: 'review' })]);
    expect(ex!.reply_sequence).toBe(2);
  });

  test('`conversation` is a show section', () => {
    expect(parseShowSections(['conversation']).invalid).toEqual([]);
  });
});
