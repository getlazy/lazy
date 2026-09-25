import { describe, expect, test } from 'bun:test';
import { isValidSlug, isValidTarget, normalizeSlug, randomSlug } from '../src/slug';

describe('slugs', () => {
  test('random slugs have the requested length and no lookalike characters', () => {
    for (let i = 0; i < 200; i++) {
      const slug = randomSlug(8);
      expect(slug).toHaveLength(8);
      expect(slug).not.toMatch(/[l1o0]/);
    }
  });

  test('custom slugs are 3-32 letters, digits or dashes', () => {
    expect(isValidSlug('docs')).toBe(true);
    expect(isValidSlug('Release-Notes-2')).toBe(true);
    expect(isValidSlug('ab')).toBe(false);
    expect(isValidSlug('a'.repeat(33))).toBe(false);
    expect(isValidSlug('has space')).toBe(false);
    expect(isValidSlug('a/b')).toBe(false);
  });

  test('custom slugs are stored lowercase', () => {
    expect(normalizeSlug('Docs')).toBe('docs');
  });

  test('only http(s) targets are accepted', () => {
    expect(isValidTarget('https://example.com')).toBe(true);
    expect(isValidTarget('http://example.com/a?b=c')).toBe(true);
    expect(isValidTarget('javascript:alert(1)')).toBe(false);
    expect(isValidTarget('not a url')).toBe(false);
  });
});
