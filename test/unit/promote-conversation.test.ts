/**
 * Seeding a task from part of a stored builder conversation.
 *
 * Two things decide whether this feature is usable: WHICH messages a request
 * resolves to, and what the seeded task says about them. Both are pure
 * functions here, so they are tested here rather than through the web form.
 */

import { describe, test, expect } from 'bun:test';
import {
  CONVERSATION_PROMOTION_METADATA_KEY,
  buildConversationTaskPrompt,
  conversationPromotions,
  decodeConversationPromotion,
  defaultConversationCode,
  defaultConversationGoal,
  encodeConversationPromotion,
  formatMessageRange,
  messagesInRange,
  rangesOverlap,
  resolveMessageRange,
} from '../../src/conversation/promote';
import type { StoredConversation, StoredMessage } from '../../src/storage/types';
import type { Task } from '../../src/types';

function msg(role: 'user' | 'assistant', text: string): StoredMessage {
  return { uuid: `${role}-${text.slice(0, 6)}`, parentUuid: null, timestamp: '2026-09-01T10:00:00.000Z', role, text, model: null, usage: null };
}

function conversation(messages: StoredMessage[], summary = 'A builder session'): StoredConversation {
  return {
    sessionId: '3f9a01b2-1111-2222-3333-444444444444',
    projectPath: '-tmp-project',
    cwd: '/tmp/project',
    version: '2.0.0',
    gitBranch: 'main',
    startedAt: '2026-09-01T10:00:00.000Z',
    endedAt: '2026-09-01T11:00:00.000Z',
    importedAt: 1,
    summary,
    stats: {
      messageCount: messages.length,
      userMessageCount: messages.filter(m => m.role === 'user').length,
      assistantMessageCount: messages.filter(m => m.role === 'assistant').length,
    } as StoredConversation['stats'],
    totalUsage: { inputTokens: 0, outputTokens: 0 } as StoredConversation['totalUsage'],
    messages,
    subagents: [],
  };
}

const conv = conversation([
  msg('user', 'Unrelated question about the release date.'),
  msg('assistant', 'It is next week.'),
  msg('user', 'The proxy audit log should rotate instead of growing forever. It broke a store push at 677 MiB.'),
  msg('assistant', 'Agreed — a hard cap plus rotation, bounded by construction.'),
  msg('user', 'Thanks.'),
]);

describe('resolving the message range', () => {
  test('a single message is a range of one', () => {
    expect(resolveMessageRange(conv, { from: 3 })).toEqual({ from: 3, to: 3 });
  });

  test('defaults to the first message when nothing is asked for', () => {
    expect(resolveMessageRange(conv, {})).toEqual({ from: 1, to: 1 });
  });

  // INVARIANT: a range past the end of the transcript is REFUSED, not clamped.
  // Clamping would seed a task from messages the human did not select and the
  // task would exist before anyone noticed the mismatch.
  test('refuses a range the transcript does not have', () => {
    expect(() => resolveMessageRange(conv, { from: 4, to: 9 })).toThrow(/5 messages/);
    expect(() => resolveMessageRange(conv, { from: 0 })).toThrow(/start at 1/);
    expect(() => resolveMessageRange(conv, { from: 4, to: 2 })).toThrow(/ends before it starts/);
    expect(() => resolveMessageRange(conversation([]), { from: 1 })).toThrow(/no messages/);
  });

  test('slices the messages it names, inclusive on both ends', () => {
    expect(messagesInRange(conv, { from: 3, to: 4 }).map(m => m.role)).toEqual(['user', 'assistant']);
  });
});

describe('what the seeded task says', () => {
  test("the goal is the human's own sentence, not the builder's answer", () => {
    const goal = defaultConversationGoal(conv, { from: 3, to: 4 });
    expect(goal).toBe('The proxy audit log should rotate instead of growing forever.');
    expect(defaultConversationCode(goal)).toBeTruthy();
  });

  test('falls back past an unusable human line rather than seeding an empty goal', () => {
    const goal = defaultConversationGoal(conv, { from: 5, to: 5 });
    expect(goal.length).toBeGreaterThan(0);
  });

  // INVARIANT: the seeded prompt carries the selected messages VERBATIM.
  // Summarising here would drop exactly the detail the promotion exists to
  // keep — the human edits this text before the task is created.
  test('the prompt is the selected messages verbatim, plus provenance', () => {
    const prompt = buildConversationTaskPrompt(conv, { from: 3, to: 4 });
    expect(prompt).toContain('It broke a store push at 677 MiB.');
    expect(prompt).toContain('a hard cap plus rotation');
    expect(prompt).not.toContain('Unrelated question');
    expect(prompt).toContain(`Promoted from builder conversation ${conv.sessionId} (messages 3–4 of 5).`);
  });

  test('an empty message is marked rather than rendered as a silent gap', () => {
    const withEmpty = conversation([msg('assistant', '')]);
    expect(buildConversationTaskPrompt(withEmpty, { from: 1, to: 1 })).toContain('recorded no text');
  });
});

describe('the durable link back', () => {
  function task(id: string, code: string | null, link: string | null): Task {
    return {
      id,
      code,
      goal: 'g',
      status: 'backlog',
      metadata: link ? { [CONVERSATION_PROMOTION_METADATA_KEY]: link } : null,
    } as unknown as Task;
  }

  test('round-trips through the task metadata value', () => {
    const encoded = encodeConversationPromotion(conv.sessionId, { from: 3, to: 4 });
    expect(decodeConversationPromotion(encoded)).toEqual({ sessionId: conv.sessionId, range: { from: 3, to: 4 } });
    expect(decodeConversationPromotion('not-a-link')).toBeNull();
    expect(decodeConversationPromotion(null)).toBeNull();
  });

  // INVARIANT: promotions are DERIVED from the tasks, never stored on the
  // conversation record — capture rewrites a whole StoredConversation whenever
  // the session grows, so a marker written there is lost on the next message.
  test('finds every task promoted from one conversation, in transcript order', () => {
    const tasks = [
      task('bbbb', 'later-task', encodeConversationPromotion(conv.sessionId, { from: 8, to: 9 })),
      task('aaaa', 'earlier-task', encodeConversationPromotion(conv.sessionId, { from: 3, to: 4 })),
      task('cccc', 'other-conversation', encodeConversationPromotion('9999', { from: 1, to: 2 })),
      task('dddd', 'unpromoted', null),
    ];
    expect(conversationPromotions(tasks, conv.sessionId).map(p => p.task.code)).toEqual([
      'earlier-task',
      'later-task',
    ]);
  });

  test('overlap is what warns a second promoter', () => {
    expect(rangesOverlap({ from: 3, to: 6 }, { from: 6, to: 8 })).toBe(true);
    expect(rangesOverlap({ from: 3, to: 5 }, { from: 6, to: 8 })).toBe(false);
  });

  test('a one-message range reads as one number', () => {
    expect(formatMessageRange({ from: 7, to: 7 })).toBe('7');
    expect(formatMessageRange({ from: 7, to: 9 })).toBe('7–9');
  });
});
