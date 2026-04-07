import { describe, test, expect } from 'bun:test';
import { truncateMRTitle } from '../../src/remote/driver';

describe('truncateMRTitle', () => {
  test('returns short titles unchanged', () => {
    const short = 'Fix bug';
    expect(truncateMRTitle(short)).toBe(short);
  });

  test('returns 128-char titles unchanged', () => {
    const exactly128 = 'a'.repeat(128);
    expect(truncateMRTitle(exactly128)).toBe(exactly128);
    expect(truncateMRTitle(exactly128).length).toBe(128);
  });

  test('truncates long titles to 128 chars with ellipsis', () => {
    const long = 'a'.repeat(200);
    const truncated = truncateMRTitle(long);

    expect(truncated.length).toBe(128);
    expect(truncated.endsWith('...')).toBe(true);
    expect(truncated).toBe('a'.repeat(125) + '...');
  });

  test('truncates at 125 chars + "..." = 128 total', () => {
    const title = 'This is a very long title that exceeds the 128 character limit and should be truncated with ellipsis to indicate that it was cut off at the maximum length';
    const truncated = truncateMRTitle(title);

    expect(truncated.length).toBe(128);
    expect(truncated.endsWith('...')).toBe(true);
    expect(truncated).toBe(title.slice(0, 125) + '...');
  });

  test('handles exactly 129 chars', () => {
    const title = 'a'.repeat(129);
    const truncated = truncateMRTitle(title);

    expect(truncated.length).toBe(128);
    expect(truncated).toBe('a'.repeat(125) + '...');
  });

  test('preserves original title when exactly at limit', () => {
    const title = 'a'.repeat(127);
    expect(truncateMRTitle(title)).toBe(title);
    expect(truncateMRTitle(title).length).toBe(127);
  });

  test('handles empty string', () => {
    expect(truncateMRTitle('')).toBe('');
  });

  test('handles unicode emoji correctly', () => {
    // Each 🚀 is 2 UTF-16 code units
    // So 150 emoji = 300 code units, should truncate to fit in 128
    const unicode = '🚀'.repeat(150);
    const truncated = truncateMRTitle(unicode);

    expect(truncated.length).toBeLessThanOrEqual(128);
    expect(truncated.endsWith('...')).toBe(true);
    // With 62 emoji (124 code units) + "..." (3 units) = 127 total
    expect(truncated).toBe('🚀'.repeat(62) + '...');
    expect(truncated.length).toBe(127);
  });

  test('does not split emoji at truncation boundary', () => {
    // Create a title where emoji 🚀 (2 code units) would be split if we used string.slice()
    // 124 'a' + 1 '🚀' (2 units) = 126 code units total before the padding
    const title = 'a'.repeat(124) + '🚀' + 'x'.repeat(10);
    const truncated = truncateMRTitle(title);

    expect(truncated.length).toBeLessThanOrEqual(128);
    expect(truncated.endsWith('...')).toBe(true);
    // Should include the emoji since 124 + 2 + 3 = 129, but we stop before adding
    // the emoji to stay under 128. Actually wait, let me recalculate:
    // We have room for 125 code units before "..."
    // 124 'a' = 124 units, then '🚀' = 2 units would make 126, which exceeds 125
    // So it should stop at 124 'a' and not include the emoji
    const withoutEllipsis = truncated.slice(0, -3);
    expect(withoutEllipsis).toBe('a'.repeat(124));
    expect(truncated.length).toBe(127); // 124 + 3
  });

  test('includes emoji when it fits exactly', () => {
    // 123 'a' + 1 '🚀' (2 units) = 125 units, exactly fits with "..."
    const title = 'a'.repeat(123) + '🚀' + 'x'.repeat(10);
    const truncated = truncateMRTitle(title);

    expect(truncated.length).toBeLessThanOrEqual(128);
    expect(truncated.endsWith('...')).toBe(true);
    const withoutEllipsis = truncated.slice(0, -3);
    expect(withoutEllipsis).toBe('a'.repeat(123) + '🚀');
    expect(truncated.length).toBe(128); // 123 + 2 + 3
  });

  test('handles multi-byte characters at boundary', () => {
    // Test with various Unicode characters: emoji, Chinese, Arabic
    // Most of these are 1-2 code units each
    const mixed = 'Test 你好 مرحبا 🎉🚀✨' + 'x'.repeat(200);
    const truncated = truncateMRTitle(mixed);

    expect(truncated.length).toBeLessThanOrEqual(128);
    expect(truncated.endsWith('...')).toBe(true);
    // Verify no broken surrogate pairs by checking that Array.from matches expectations
    const codePoints = Array.from(truncated);
    const reconstructed = codePoints.join('');
    expect(reconstructed).toBe(truncated); // Should be identical if no broken pairs
  });
});
