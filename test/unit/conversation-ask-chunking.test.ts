/**
 * Unit: transcript chunking for `lazy ask <conversation-id>`.
 *
 * The chunker decides what a throwaway ask agent gets to see. Its boundary
 * behaviour is the part of the conversation ask most likely to regress
 * silently — a chunk that overshoots the budget fails the spawn with E2BIG
 * (argv, not context, is the binding limit), and a message quietly cut in half
 * produces a confident answer built from a fragment.
 *
 * INVARIANT: a message is never split across two chunks. The single exception
 * is a message that alone exceeds the budget — it is truncated in place, marked
 * in the text, AND reported as a warning. Truncating without the warning is the
 * failure mode this suite exists to prevent.
 */

import { describe, test, expect } from 'bun:test';
import { chunkTranscript, TRANSCRIPT_CHARS_PER_CALL } from '../../src/conversation/ask';
import type { StoredMessage } from '../../src/storage/types';

function msg(text: string, role: 'user' | 'assistant' = 'user', i = 0): StoredMessage {
  return {
    uuid: `u${i}`,
    parentUuid: null,
    timestamp: '2026-07-12T10:00:00Z',
    role,
    text,
    model: null,
    usage: null,
  };
}

describe('chunkTranscript', () => {
  test('a small conversation is one chunk with no warnings', () => {
    const chunks = chunkTranscript([msg('hello'), msg('hi', 'assistant', 1)]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].warnings).toEqual([]);
    expect(chunks[0].text).toContain('hello');
    expect(chunks[0].text).toContain('hi');
  });

  test('renders role and timestamp so the agent can attribute lines', () => {
    const [chunk] = chunkTranscript([msg('decided X', 'assistant', 0)]);
    expect(chunk.text).toContain('assistant');
    expect(chunk.text).toContain('decided X');
  });

  test('splits at message boundaries and never exceeds the budget', () => {
    const budget = 1000;
    const messages = Array.from({ length: 10 }, (_, i) => msg('z'.repeat(300), 'user', i));
    const chunks = chunkTranscript(messages, budget);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(budget);
    }
    // Every message survives somewhere, whole: the concatenation contains one
    // rendered header per message.
    const joined = chunks.map(c => c.text).join('\n\n');
    expect(joined.split('z'.repeat(300)).length - 1).toBe(10);
  });

  test('a single oversized message is elided in place AND warned about', () => {
    const budget = 500;
    const chunks = chunkTranscript([msg('q'.repeat(5000))], budget);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('elided by lazy');
    expect(chunks[0].warnings).toHaveLength(1);
    expect(chunks[0].warnings[0]).toContain('too large to pass whole');
  });

  test('an empty transcript yields no chunks', () => {
    expect(chunkTranscript([])).toEqual([]);
  });

  test('the default budget leaves head room under the 128 KiB argv cap', () => {
    // MAX_ARG_STRLEN on Linux is 128 KiB for one argv element, and the prompt
    // is passed as a single `claude -p <prompt>` argument. The transcript
    // budget must leave room for the template, metadata and question.
    expect(TRANSCRIPT_CHARS_PER_CALL).toBeLessThan(128 * 1024);
  });
});
