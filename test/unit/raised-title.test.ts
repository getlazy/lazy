/**
 * Display-derived raised-item titles. A first-period cut is not a sentence
 * boundary — enumerator prefixes like `H.` used to become the whole title.
 */

import { describe, test, expect } from 'bun:test';
import { firstSentence, raisedTitle, truncateAtWordBoundary } from '../../src/raised/title';

describe('firstSentence', () => {
  // The exact content that shipped as title `H.` on raised item 51492d5d.
  test('does not cut enumerator prefixes like H. MOVE candidates…', () => {
    const content =
      'H. MOVE candidates, per row of plan §5.2, onto the next release hub';
    expect(firstSentence(content)).toBe(content);
    expect(raisedTitle(content)).toBe(content);
  });

  test('treats 1. and A) prefixes as part of the sentence', () => {
    expect(firstSentence('1. Enable the flag by default.')).toBe(
      '1. Enable the flag by default.',
    );
    expect(firstSentence('A) Keep the escape hatch. Then ship.')).toBe(
      'A) Keep the escape hatch.',
    );
  });

  test('cuts at the first real sentence end after a prefix', () => {
    expect(firstSentence('H. MOVE candidates now. Then the rest.')).toBe(
      'H. MOVE candidates now.',
    );
  });

  test('prefers the first line over collapsing the whole body', () => {
    expect(firstSentence('Short title.\n\nA longer paragraph follows.')).toBe(
      'Short title.',
    );
    expect(firstSentence('No terminator on this line\nSecond line.')).toBe(
      'No terminator on this line',
    );
  });

  test('does not cut inside backticks or parentheses', () => {
    expect(firstSentence('See `foo. bar` for the helper.')).toBe(
      'See `foo. bar` for the helper.',
    );
    expect(firstSentence('Decide (see docs.) then ship.')).toBe(
      'Decide (see docs.) then ship.',
    );
    // loader.ts: the '.' is followed by a letter, not whitespace.
    expect(firstSentence('See loader.ts for details.')).toBe(
      'See loader.ts for details.',
    );
  });
});

describe('truncateAtWordBoundary', () => {
  test('caps at a word boundary and appends an ellipsis', () => {
    const long = 'the quick brown fox jumps over the lazy dog extra';
    expect(truncateAtWordBoundary(long, 24)).toBe('the quick brown fox…');
    expect(truncateAtWordBoundary('short', 80)).toBe('short');
  });
});
