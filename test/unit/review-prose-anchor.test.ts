/**
 * Unit tests: prose anchors — review comments attached to a line of the
 * agent's prose (report sections, follow-ups, raised items).
 *
 * Two load-bearing properties:
 *  - the anchor (a content hash of the block text + section kind) is STABLE
 *    across re-renders and identical between the server (TS) and the review
 *    island (its embedded JS mirror), or threads would detach on every poll;
 *  - prompts built from a prose anchor quote the text and NEVER render the
 *    pseudo-file or the hash as a fake file/line the agent would hunt for.
 */

import { describe, test, expect } from 'bun:test';
import {
  PROSE_REPORT_FILE,
  PROSE_ANCHOR_FILE_RE_SOURCE,
  PROSE_ANCHOR_HASH_JS,
  followUpProseFile,
  raisedItemProseFile,
  isProseReviewAnchor,
  proseAnchorLine,
  proseAnchorAgentWhere,
  proseAnchorReviewerWhere,
} from '../../src/review/prose-anchor';
import { buildUnblockPrompt, buildAskPrompt } from '../../src/daemon/review-service';
import type { ReviewComment } from '../../src/types';

describe('prose anchor derivation', () => {
  test('is stable for identical text and differs when the words change', () => {
    const a = proseAnchorLine('what_was_done', 'Kept plugins Anthropic-only by construction.');
    const b = proseAnchorLine('what_was_done', 'Kept plugins Anthropic-only by construction.');
    const c = proseAnchorLine('what_was_done', 'Kept plugins Anthropic-only, mostly.');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  // Markdown source and DOM textContent disagree about whitespace (wrapping,
  // indentation); the anchor must not care, or a client-derived line would
  // never match a server-derived one.
  test('normalizes whitespace so wrapping does not move the anchor', () => {
    const flat = proseAnchorLine('', 'one two three');
    expect(proseAnchorLine('', 'one\n  two\tthree')).toBe(flat);
    expect(proseAnchorLine('', '  one two three  ')).toBe(flat);
  });

  test('includes the section kind, so identical text in two sections anchors separately', () => {
    expect(proseAnchorLine('commentary', 'Done.')).not.toBe(proseAnchorLine('how_to_verify', 'Done.'));
  });

  // line 0 belongs to the (task) sentinel; a prose line of 0 would make
  // sentinel checks ambiguous on sloppy call sites.
  test('is always a positive integer', () => {
    expect(proseAnchorLine('', '')).toBeGreaterThan(0);
    for (const s of ['a', 'why?', 'x'.repeat(5000)]) {
      const line = proseAnchorLine('kind', s);
      expect(Number.isInteger(line)).toBe(true);
      expect(line).toBeGreaterThan(0);
    }
  });

  // INVARIANT: the island's embedded hash is a MIRROR of the TS one. If they
  // drift, every thread detaches from its block the moment the page loads.
  test('the client JS mirror computes the same line as the TS implementation', () => {
    const mirror = new Function(`${PROSE_ANCHOR_HASH_JS}; return proseAnchorLine;`)() as (
      kind: string,
      text: string,
    ) => number;
    const samples: Array<[string, string]> = [
      ['', 'plain paragraph'],
      ['what_was_done', 'Request plugins and policy enforcement stay Anthropic-only by construction.'],
      ['commentary', '  spaced\n out\ttext '],
      ['kind', 'unicode — dashes, “quotes”, émojis 🎉'],
    ];
    for (const [kind, text] of samples) {
      expect(mirror(kind, text)).toBe(proseAnchorLine(kind, text));
    }
  });

  test('recognizes prose pseudo-files and nothing else', () => {
    const re = new RegExp(PROSE_ANCHOR_FILE_RE_SOURCE);
    for (const file of [PROSE_REPORT_FILE, followUpProseFile('abc-123'), raisedItemProseFile('def')]) {
      expect(isProseReviewAnchor(file)).toBe(true);
      expect(re.test(file)).toBe(true); // client mirror agrees
    }
    // The (task) sentinel is NOT a prose anchor — it has its own rules.
    for (const file of ['(task)', 'src/foo.ts', '(report', '(followup:)', '(other:x)']) {
      expect(isProseReviewAnchor(file)).toBe(false);
      expect(re.test(file)).toBe(false);
    }
  });

  // INVARIANT: one entity, one vocabulary. A comment stored against the LEGACY
  // `(followup:<id>)` anchor still parses, and reads back in raised-item words —
  // the unification renamed what the human and the agent are shown, not what is
  // already on disk.
  test('labels for prompts and the queued list name the surface, not the pseudo-file', () => {
    expect(proseAnchorAgentWhere(PROSE_REPORT_FILE)).toBe('your report');
    expect(proseAnchorAgentWhere(followUpProseFile('x'))).toBe('an item you raised');
    expect(proseAnchorAgentWhere(raisedItemProseFile('x'))).toBe('an item you raised');
    expect(proseAnchorReviewerWhere(PROSE_REPORT_FILE)).toBe('on the report');
    expect(proseAnchorReviewerWhere(followUpProseFile('x'))).toBe('on a raised item');
    expect(proseAnchorReviewerWhere(raisedItemProseFile('x'))).toBe('on a raised item');
  });
});

describe('prompt rendering for prose anchors', () => {
  const QUOTE = 'Request plugins and policy enforcement stay Anthropic-only by construction.';
  const LINE = proseAnchorLine('what_was_done', QUOTE);

  function c(over: Partial<ReviewComment>): ReviewComment {
    return {
      id: 'c1', task_id: 't1', thread_id: 'c1', file: PROSE_REPORT_FILE, line: LINE,
      side: 'new', role: 'human', content: 'body', created_at: 1,
      intent: 'comment', delivery_state: 'pending_delivery',
      anchor_snippet: QUOTE,
      ...over,
    };
  }

  // The agent gets the quote, never the pseudo-file or the hash rendered as a
  // fake file/line it would go hunting for.
  test('an unblock carrying a prose comment quotes the report line, with no fake file/line', () => {
    const request = c({ content: 'make a follow-up for this' });
    const prompt = buildUnblockPrompt([request], [request], 'go');
    expect(prompt).toContain('On your report, the line:');
    expect(prompt).toContain(`> ${QUOTE}`);
    expect(prompt).toContain('make a follow-up for this');
    expect(prompt).not.toContain('(report)');
    expect(prompt).not.toContain(`line ${LINE}`);
  });

  test('a prose reply without its own snippet inherits the quote from its thread', () => {
    const question = c({ id: 'q', thread_id: 'q', intent: 'ask', content: 'why?', created_at: 1 });
    const answer = c({ id: 'r', thread_id: 'q', role: 'agent', content: 'because policy', created_at: 2, anchor_snippet: undefined });
    const reply = c({ id: 'w', thread_id: 'q', content: 'alright, do that', created_at: 3, anchor_snippet: undefined });
    const prompt = buildUnblockPrompt([reply], [question, answer, reply], 'go');
    expect(prompt).toContain(`> ${QUOTE}`);
    expect(prompt).toContain('Earlier on this thread:');
    expect(prompt).toContain('why?');
    expect(prompt).toContain('because policy');
  });

  test('a comment on a legacy follow-up anchor says "an item you raised"', () => {
    const request = c({ file: followUpProseFile('fu-1'), content: 'promote this' });
    const prompt = buildUnblockPrompt([request], [request], 'go');
    expect(prompt).toContain('On an item you raised, the line:');
    expect(prompt).not.toContain('(followup:');
  });

  test('an ask on a prose anchor uses the prose template: where + quote + thread, no file/line', () => {
    const ask = c({ intent: 'ask', content: 'why?', delivery_state: undefined, ask_state: 'pending' });
    const prompt = buildAskPrompt([ask], ask);
    expect(prompt).toContain('a line of your report');
    expect(prompt).toContain(`> ${QUOTE}`);
    expect(prompt).toContain('**Reviewer:** why?');
    expect(prompt).toContain('do not change any code');
    expect(prompt).not.toContain('(report)');
    expect(prompt).not.toContain('**File:**');
    expect(prompt).not.toContain(`line ${LINE}`);
  });

  test('a diff-line ask still uses the file/line template', () => {
    const ask = c({ file: 'src/foo.ts', line: 3, intent: 'ask', content: 'why?', anchor_snippet: '+const b = 3;' });
    const prompt = buildAskPrompt([ask], ask);
    expect(prompt).toContain('**File:** `src/foo.ts`');
    expect(prompt).toContain('**Line:** 3');
  });
});
