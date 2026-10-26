import { describe, test, expect } from 'bun:test';
import { buildChat, chatTextOf } from '../../src/task/chat';
import { buildAskPrompt } from '../../src/daemon/review-service';
import { TASK_LEVEL_REVIEW_ANCHOR } from '../../src/review/task-level-anchor';
import type { ReviewComment, Turn } from '../../src/types';

function turn(sequence: number, role: 'human' | 'agent', content: string, turnType: Turn['turn_type'] = 'ask', at = sequence * 1000): Turn {
  return {
    id: `t${sequence}`, session_id: 's', sequence, role, content, timestamp: at, usage: null,
    start_sha: null, start_sha_work: null, end_sha_work: null, end_sha: null, turn_type: turnType,
  } as Turn;
}

function comment(over: Partial<ReviewComment>): ReviewComment {
  return {
    id: 'c1', task_id: 'task', thread_id: 'c1', ...TASK_LEVEL_REVIEW_ANCHOR,
    role: 'human', content: 'why?', created_at: 1, intent: 'ask', ...over,
  } as ReviewComment;
}

describe('task chat projection', () => {
  // INVARIANT: Chat shows what the person typed and what the agent answered —
  // never lazy's framing. The framed prompt is the agent's, not the reader's.
  test('a framed review ask shows only the reviewer’s words', () => {
    const latest = comment({ content: 'Why a map and not a set?' });
    const framed = buildAskPrompt([latest], latest);
    expect(framed).toContain('A reviewer has a question');
    expect(chatTextOf(framed)).toBe('Why a map and not a set?');

    const line = comment({ file: 'src/a.ts', line: 12, side: 'new', content: 'Is this safe?' });
    expect(chatTextOf(buildAskPrompt([line], line))).toBe('Is this safe?');
  });

  test('a thread’s LATEST reviewer message is the one shown', () => {
    const first = comment({ id: 'a', content: 'First?' });
    const reply = comment({ id: 'b', role: 'agent', content: 'Answer.' });
    const second = comment({ id: 'c', content: 'And second?' });
    expect(chatTextOf(buildAskPrompt([first, reply, second], second))).toBe('And second?');
  });

  test('only ask turns are chat; work, nudges and reviews are not', () => {
    const chat = buildChat([
      turn(0, 'human', 'Build it', 'work'),
      turn(1, 'agent', 'Built.', 'work'),
      turn(2, 'human', 'Why X?'),
      turn(3, 'agent', 'Because Y.'),
      turn(4, 'human', '[Supervisor] commit please', 'nudge'),
      turn(5, 'agent', 'Done', 'nudge'),
    ], []);
    expect(chat.map((m) => [m.from, m.text])).toEqual([
      ['person', 'Why X?'],
      ['agent', 'Because Y.'],
    ]);
    expect(chat[0]!.state).toBe('answered');
  });

  test('an unanswered ask is pending, and a queued comment with its words is not shown twice', () => {
    const chat = buildChat([turn(2, 'human', 'Still thinking?')], [
      comment({ content: 'Still thinking?', ask_state: 'pending', created_at: 2500 }),
    ]);
    expect(chat).toHaveLength(1);
    expect(chat[0]!.state).toBe('pending');
  });

  test('a review ask answered by a turn names where it was asked, once', () => {
    const chat = buildChat([turn(2, 'human', 'Is this safe?'), turn(3, 'agent', 'Yes.')], [
      comment({ id: 'q', thread_id: 'q', file: 'src/a.ts', line: 12, side: 'new', content: 'Is this safe?', ask_state: 'answered', turn_number: 2 }),
      comment({ id: 'r', thread_id: 'q', file: 'src/a.ts', line: 12, side: 'new', role: 'agent', content: 'Yes.', turn_number: 2, intent: undefined }),
    ]);
    expect(chat.map((m) => m.text)).toEqual(['Is this safe?', 'Yes.']);
    expect(chat[0]!.about).toBe('on src/a.ts:12');
  });

  test('an answer from the stored record (no turn) comes from the review thread', () => {
    const chat = buildChat([], [
      comment({ id: 'q', thread_id: 'q', content: 'What shipped?', ask_state: 'answered', created_at: 10 }),
      comment({ id: 'r', thread_id: 'q', role: 'agent', content: 'The parser.', created_at: 20, intent: undefined }),
    ]);
    expect(chat.map((m) => [m.from, m.text, m.from_record])).toEqual([
      ['person', 'What shipped?', false],
      ['agent', 'The parser.', true],
    ]);
  });

  // INVARIANT: a crash, watchdog kill or abandoned ask is NOT an answer — the
  // question reads not answered, and the notice (stderr and all) never shows.
  for (const [name, notice] of [
    ['crashed', '[Agent crashed]\n\nError: boom\nExit code: 1\n\nStderr:\nsecret trace'],
    ['watchdog', '[Agent killed by watchdog — no forward progress]\n\nError: no output for 600s'],
    ['abandoned', '[Ask abandoned]\n\nThe run is gone.\n\nStatus restored to \'blocked\'.'],
  ] as const) {
    test(`a ${name} ask reads not answered, without the notice`, () => {
      const chat = buildChat([turn(2, 'human', 'Why?'), turn(3, 'agent', notice)], []);
      expect(chat).toHaveLength(1);
      expect(chat[0]!.state).toBe('failed');
      expect(chat[0]!.error).toBeTruthy();
      expect(JSON.stringify(chat)).not.toContain('Stderr');
    });
  }

  test('both halves of an ask carry the agent turn\'s number, even off pair alignment', () => {
    const chat = buildChat([turn(3, 'human', 'Odd?'), turn(4, 'agent', 'Yes.')], [
      comment({ file: 'src/a.ts', line: 1, side: 'new', content: 'Odd?', ask_state: 'answered', turn_number: 3 }),
    ]);
    expect(chat.map((m) => m.turn_number)).toEqual([3, 3]);
    expect(chat[0]!.about).toBe('on src/a.ts:1');
  });

  test('a question the builder or an agent asked is labelled as such', () => {
    const asked = { ...turn(2, 'human', 'Status?'), actor: 'builder' } as Turn;
    expect(buildChat([asked], [])[0]!.asked_by).toBe('builder');
    expect(buildChat([turn(2, 'human', 'Hi')], [])[0]!.asked_by).toBe('person');
  });

  test('a failed ask carries its reason; a withdrawn one and a plain comment are not chat', () => {
    const chat = buildChat([], [
      comment({ id: 'f', thread_id: 'f', content: 'Hello?', ask_state: 'failed', ask_error: 'task is working' }),
      comment({ id: 'w', thread_id: 'w', content: 'Never mind', ask_state: 'failed', withdrawn_at: 5 }),
      comment({ id: 'n', thread_id: 'n', content: 'Please rename', intent: 'comment' }),
    ]);
    expect(chat).toHaveLength(1);
    expect(chat[0]).toMatchObject({ state: 'failed', error: 'task is working' });
  });
});
