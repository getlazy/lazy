import { describe, test, expect } from 'bun:test';
import { deriveCode, validateCode } from '../../src/cli/helpers';

describe('deriveCode', () => {
  test('derives code from simple branch name', () => {
    expect(deriveCode('ivan/deno-v2')).toBe('ivan-deno-v2');
  });

  test('derives code from feature branch', () => {
    expect(deriveCode('feature/auth-fix')).toBe('feature-auth-fix');
  });

  test('lowercases everything', () => {
    expect(deriveCode('Ivan/Deno-V2')).toBe('ivan-deno-v2');
  });

  test('replaces multiple non-alphanumeric chars with single hyphen', () => {
    expect(deriveCode('foo///bar')).toBe('foo-bar');
    expect(deriveCode('foo___bar')).toBe('foo-bar');
  });

  test('collapses multiple dots to single dot', () => {
    expect(deriveCode('foo...bar')).toBe('foo.bar');
    expect(deriveCode('foo..bar')).toBe('foo.bar');
  });

  test('preserves single dots', () => {
    expect(deriveCode('release/v1.0')).toBe('release-v1.0');
    expect(deriveCode('v1.2.3')).toBe('v1.2.3');
    expect(deriveCode('hotfix-v2.1')).toBe('hotfix-v2.1');
  });

  test('strips leading and trailing hyphens', () => {
    expect(deriveCode('/feature/test')).toBe('feature-test');
    expect(deriveCode('feature/test/')).toBe('feature-test');
  });

  test('truncates to 80 characters', () => {
    const longInput = 'feature/' + 'a'.repeat(100);
    const result = deriveCode(longInput);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(80);
  });

  test('preserves longer branch names that fit within 80 chars', () => {
    const result = deriveCode('feature/very-long-branch-name-that-exceeds');
    expect(result).not.toBeNull();
    expect(result).toBe('feature-very-long-branch-name-that-exceeds');
  });

  test('strips trailing hyphens after truncation', () => {
    // "feature/x-" at position 20 would leave a trailing hyphen
    const result = deriveCode('aaaaaaaaaaaaaaaaaaa-bbb');
    expect(result).not.toBeNull();
    expect(result!).not.toMatch(/-$/);
  });

  test('returns null for too-short input', () => {
    expect(deriveCode('a')).toBeNull();
    expect(deriveCode('/')).toBeNull();
    expect(deriveCode('')).toBeNull();
  });

  test('returns null for input that becomes reserved prefix', () => {
    expect(deriveCode('lazy-something')).toBeNull();
  });

  test('all derived codes pass validation', () => {
    const inputs = [
      'ivan/deno-v2',
      'feature/auth-fix',
      'bugfix/issue-123',
      'release/v1.0.0',
      'user/long-feature-branch-name',
    ];
    for (const input of inputs) {
      const code = deriveCode(input);
      if (code !== null) {
        expect(validateCode(code)).toBeNull();
      }
    }
  });
});
