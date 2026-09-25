/**
 * INVARIANT: a raised item's `title`, `content` and `explanation` are
 * INDEPENDENT fields, and every surface that renders the item shows all three.
 *
 * Both halves of this used to drop the body. `normalizeRaisedCreateInput`
 * composed the stored content from title+explanation whenever a title was
 * present — destroying the agent's body at write time — and `raisedDisplayBody`
 * re-derived the same composition at read time, so even a correctly stored body
 * would not have been displayed. Do NOT "simplify" either one back into
 * reading a single field.
 */

import { describe, test, expect } from 'bun:test';
import { raisedDisplayBody, composeRaisedContent } from '../../src/raised/title';
import { normalizeRaisedCreateInput } from '../../src/raised/content';

describe('raisedDisplayBody', () => {
  test('shows title, content and explanation when all three are present', () => {
    const body = raisedDisplayBody({
      title: 'Failed retries should surface',
      content: 'The retry path swallows errors.',
      explanation: 'Operators see a green run that did nothing.',
    });
    expect(body).toBe(
      'Failed retries should surface\n\n' +
      'The retry path swallows errors.\n\n' +
      'Operators see a green run that did nothing.',
    );
  });

  // Items stored before the two fields were independent (and any item created
  // without a body of its own) hold content DERIVED from title+explanation.
  // Rendering that as a separate paragraph would print it twice.
  test('does not repeat a content that was derived from title+explanation', () => {
    expect(raisedDisplayBody({
      title: 'Stale credentials should fail loudly',
      content: composeRaisedContent('Stale credentials should fail loudly', 'Today it hangs.'),
      explanation: 'Today it hangs.',
    })).toBe('Stale credentials should fail loudly\n\nToday it hangs.');

    expect(raisedDisplayBody({
      title: 'Title only',
      content: 'Title only',
    })).toBe('Title only');
  });

  test('a plain note renders as itself', () => {
    expect(raisedDisplayBody({ content: 'orthogonal cleanup idea' }))
      .toBe('orthogonal cleanup idea');
  });
});

describe('normalizeRaisedCreateInput', () => {
  test('keeps a supplied content verbatim alongside the title', () => {
    const normalized = normalizeRaisedCreateInput({
      blocking: false,
      title: 'One-line headline',
      content: 'Paragraph one.\n\nParagraph two.',
      explanation: 'Why it matters.',
    });
    expect(normalized.content).toBe('Paragraph one.\n\nParagraph two.');
    expect(normalized.title).toBe('One-line headline');
    expect(normalized.explanation).toBe('Why it matters.');
  });

  test('derives content from title+explanation only when no body was given', () => {
    const normalized = normalizeRaisedCreateInput({
      blocking: true,
      title: 'One-line headline',
      explanation: 'Why it matters.',
    });
    expect(normalized.content).toBe('One-line headline\n\nWhy it matters.');
  });

  test('the legacy `note` spelling is a body too, and survives a title', () => {
    const normalized = normalizeRaisedCreateInput({
      blocking: false,
      title: 'Headline',
      note: 'legacy body',
    });
    expect(normalized.content).toBe('legacy body');
    expect(normalized.title).toBe('Headline');
  });
});
