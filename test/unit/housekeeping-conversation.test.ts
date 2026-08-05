/**
 * Unit tests for the stored-conversation housekeeping classifier.
 *
 * INVARIANT: the false POSITIVE is the dangerous direction. Missing a
 * housekeeping conversation costs one row of noise in `lazy builder list`;
 * matching a real conversation destroys history that lazy cannot restore. Every
 * "must NOT match" test below encodes a way a real conversation could be
 * mistaken for a one-shot, and none of them may be relaxed to catch more
 * housekeeping.
 *
 * The positive fixtures are built from the REAL prompt files (imported as text)
 * rather than from hand-copied excerpts, so rewording a prompt that these
 * conversations were captured under fails here loudly instead of silently
 * turning the purge into a no-op.
 */

import { describe, test, expect } from 'bun:test';
import {
  classifyHousekeepingConversation,
  findHousekeepingConversations,
} from '../../src/import/housekeeping-conversation';
import { markMachineOneshotPrompt } from '../../src/import/machine-oneshot';
import type { StoredConversation, StoredMessage } from '../../src/storage/types';
import fidelityPrompt from '../../src/prompts/fidelity-summary.md' with { type: 'text' };
import reportTaskPrompt from '../../src/prompts/report-task.md' with { type: 'text' };
import memoryCompactPrompt from '../../src/prompts/memory-compact-generate.md' with { type: 'text' };

/** The pairing summary prompt is inlined in src/cli/commands/pair.ts. */
const PAIRING_PROMPT =
  `Summarize this pairing session in 2-3 sentences. Focus on what was discussed, decided, and accomplished.

Conversation transcript:
[human] let's fix the daemon
[agent] done

Keep the summary concise and factual.`;

function message(role: 'user' | 'assistant', text: string, i = 0): StoredMessage {
  return {
    uuid: `u${i}`,
    parentUuid: null,
    timestamp: '2026-07-20T10:00:00Z',
    role,
    text,
    model: role === 'assistant' ? 'claude-opus-5' : null,
    usage: null,
  };
}

/** A stored conversation with the given alternating user/assistant texts. */
function conversation(texts: string[], sessionId = 'aaaaaaaa-0000-0000-0000-000000000000'): StoredConversation {
  const messages = texts.map((t, i) => message(i % 2 === 0 ? 'user' : 'assistant', t, i));
  return {
    sessionId,
    projectPath: '-Users-x-repo',
    cwd: '/Users/x/repo',
    version: '1.0.0',
    gitBranch: 'main',
    startedAt: '2026-07-20T10:00:00Z',
    endedAt: '2026-07-20T10:01:00Z',
    importedAt: 1_753_000_000_000,
    summary: texts[0]?.split('\n')[0] ?? '',
    stats: {
      messageCount: messages.length,
      userMessageCount: messages.filter(m => m.role === 'user').length,
      assistantMessageCount: messages.filter(m => m.role === 'assistant').length,
      subagentCount: 0,
      totalTokens: 100,
    },
    totalUsage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 },
    messages,
    subagents: [],
  };
}

/** The fidelity prompt as it lands in the store: placeholders substituted. */
function renderedFidelityPrompt(): string {
  return fidelityPrompt
    .replace('{{goal}}', 'Add a purge command')
    .replace('{{prompt}}', 'Purge stored housekeeping conversations')
    .replace('{{bundle}}', '### Turns (2)\n- [human]: do it\n- [agent]: done');
}

describe('classifyHousekeepingConversation — machine-generated one-shots', () => {
  test('matches the accept-time fidelity summary prompt', () => {
    const result = classifyHousekeepingConversation(
      conversation([renderedFidelityPrompt(), 'Here is the summary.']),
    );
    expect(result?.kind).toBe('fidelity-summary');
    expect(result?.reason).toContain('fidelity');
  });

  test('matches a `lazy report` stage prompt', () => {
    const result = classifyHousekeepingConversation(
      conversation([reportTaskPrompt, 'Task summary.']),
    );
    expect(result?.kind).toBe('report');
  });

  test('matches the memory compaction prompt', () => {
    const result = classifyHousekeepingConversation(
      conversation([memoryCompactPrompt, 'Compacted memory.']),
    );
    expect(result?.kind).toBe('memory-compact');
  });

  test('matches the end-of-pairing summary prompt', () => {
    const result = classifyHousekeepingConversation(
      conversation([PAIRING_PROMPT, 'You fixed the daemon.']),
    );
    expect(result?.kind).toBe('pairing-summary');
  });

  test('matches a session that carries the source-side one-shot marker', () => {
    const result = classifyHousekeepingConversation(
      conversation([markMachineOneshotPrompt('Anything at all'), 'ok']),
    );
    expect(result?.kind).toBe('marked-oneshot');
  });

  // A one-shot that crashed before Claude answered still has its prompt.
  test('matches a one-shot with no assistant reply', () => {
    expect(classifyHousekeepingConversation(conversation([renderedFidelityPrompt()]))?.kind)
      .toBe('fidelity-summary');
  });

  test('tolerates leading whitespace before the prompt', () => {
    expect(classifyHousekeepingConversation(conversation([`\n\n  ${reportTaskPrompt}`]))?.kind)
      .toBe('report');
  });
});

describe('classifyHousekeepingConversation — real conversations are never matched', () => {
  // THE dangerous case: a builder conversation ABOUT the housekeeping prompts
  // (this very task is one) quotes their wording. Anchoring at the start of the
  // first user message is what keeps it safe.
  test('does NOT match a conversation that quotes a housekeeping prompt mid-message', () => {
    const text =
      `I want to purge the old housekeeping conversations. They all start with\n` +
      `"${renderedFidelityPrompt()}"\n` +
      `so please write a classifier for them.`;
    expect(classifyHousekeepingConversation(conversation([text, 'On it.']))).toBeNull();
  });

  // A one-shot is a single `-p` prompt and nothing else. Anything with a
  // follow-up user message is a session a human actually participated in.
  test('does NOT match when the conversation has more than one user message', () => {
    const convo = conversation([
      renderedFidelityPrompt(),
      'Here is the summary.',
      'Actually, redo it with more detail.',
      'Revised summary.',
    ]);
    expect(classifyHousekeepingConversation(convo)).toBeNull();
  });

  // The opening sentence alone is plain English. The template's own section
  // header must corroborate it before anything is deleted.
  test('does NOT match the fidelity opening line without the template body', () => {
    const text = 'You are writing the description that will land on the target branch — is that right?';
    expect(classifyHousekeepingConversation(conversation([text, 'Yes.']))).toBeNull();
  });

  test('does NOT match a short real conversation with one user message', () => {
    expect(classifyHousekeepingConversation(conversation(['say hi', 'Hi!']))).toBeNull();
    expect(classifyHousekeepingConversation(conversation(['what are the blocked tasks', 'Two.']))).toBeNull();
  });

  test('does NOT match a conversation with no messages at all', () => {
    expect(classifyHousekeepingConversation(conversation([]))).toBeNull();
  });

  test('does NOT match a conversation whose only message is from the assistant', () => {
    const convo = conversation(['placeholder']);
    convo.messages = [message('assistant', renderedFidelityPrompt())];
    convo.stats.userMessageCount = 0;
    expect(classifyHousekeepingConversation(convo)).toBeNull();
  });
});

describe('findHousekeepingConversations', () => {
  test('returns only the housekeeping ones, in input order, with reasons', () => {
    const store = [
      conversation(['say hi', 'Hi!'], '11111111-0000-0000-0000-000000000000'),
      conversation([renderedFidelityPrompt(), 'Summary.'], '22222222-0000-0000-0000-000000000000'),
      conversation(['real question', 'real answer'], '33333333-0000-0000-0000-000000000000'),
      conversation([memoryCompactPrompt, 'Compacted.'], '44444444-0000-0000-0000-000000000000'),
    ];

    const matches = findHousekeepingConversations(store);
    expect(matches.map(m => m.conversation.sessionId)).toEqual([
      '22222222-0000-0000-0000-000000000000',
      '44444444-0000-0000-0000-000000000000',
    ]);
    expect(matches.map(m => m.kind)).toEqual(['fidelity-summary', 'memory-compact']);
    expect(matches.every(m => m.reason.length > 0)).toBe(true);
  });

  test('returns an empty list for a store with no housekeeping', () => {
    expect(findHousekeepingConversations([conversation(['hello', 'hi'])])).toEqual([]);
  });
});
