import { describe, test, expect } from 'bun:test';
import {
  deriveCode,
  validateCode,
  isReservedTaskPathSegment,
  RESERVED_TASK_PATH_SEGMENTS,
  TASK_PATH_SEGMENT_NEW,
  TASK_PATH_SEGMENT_LINK,
} from '../../src/task/identity';

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

  // A derived code has to be a DNS label: a task's [serve] services live at
  // <service>.<code>.lazy.localhost, where a dot would split the code into two
  // labels and address a task that does not exist.
  test('turns dots into hyphens', () => {
    expect(deriveCode('foo...bar')).toBe('foo-bar');
    expect(deriveCode('foo..bar')).toBe('foo-bar');
    expect(deriveCode('release/v1.0')).toBe('release-v1-0');
    expect(deriveCode('v1.2.3')).toBe('v1-2-3');
    expect(deriveCode('hotfix-v2.1')).toBe('hotfix-v2-1');
  });

  test('strips leading and trailing hyphens', () => {
    expect(deriveCode('/feature/test')).toBe('feature-test');
    expect(deriveCode('feature/test/')).toBe('feature-test');
  });

  test('truncates to 63 characters (the DNS label limit)', () => {
    const longInput = 'feature/' + 'a'.repeat(100);
    const result = deriveCode(longInput);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(63);
  });

  test('preserves longer branch names that fit within 63 chars', () => {
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
      'v1.2.3',
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

/**
 * A task code is now a DNS label, because it becomes one: a task's [serve]
 * services live at `<service>.<code>.lazy.localhost`.
 *
 * This governs NEW codes only. Existing dotted codes are never renamed or
 * migrated — they keep resolving everywhere, and in a hostname such a task is
 * addressed by its short id instead (see test/unit/serve-subdomain.test.ts).
 */
describe('validateCode', () => {
  test('accepts a DNS label', () => {
    expect(validateCode('my-task')).toBeNull();
    expect(validateCode('v2')).toBeNull();
    expect(validateCode('a1')).toBeNull();
    expect(validateCode('a'.repeat(63))).toBeNull();
  });

  // Said separately from the general format error: dots were valid until
  // recently, so the useful answer is why they stopped being valid and what to
  // write instead.
  test('rejects a dot, and says why', () => {
    const err = validateCode('release.v0.5');
    expect(err).not.toBeNull();
    expect(err).toContain('hostname');
    // The remedy, spelled out.
    expect(err).toContain('release-v0-5');
  });

  test('rejects what is not a label', () => {
    expect(validateCode('has_underscore')).not.toBeNull();
    expect(validateCode('-leading')).not.toBeNull();
    expect(validateCode('trailing-')).not.toBeNull();
    expect(validateCode('UPPER')).not.toBeNull();
    expect(validateCode('a')).not.toBeNull();
  });

  test('rejects a code past the DNS label limit, naming it as one', () => {
    const err = validateCode('a'.repeat(64));
    expect(err).not.toBeNull();
    expect(err).toContain('63');
    expect(err).toContain('DNS');
  });

  test('still reserves the lazy- prefix', () => {
    expect(validateCode('lazy-thing')).not.toBeNull();
  });
});

/**
 * A task code must not be a segment the web router reserves under `/tasks/`.
 *
 * INVARIANT: the reserved list has exactly one home
 * (`RESERVED_TASK_PATH_SEGMENTS`), read by all three parties — this validator,
 * the router's literal routes, and link generation's fallback. A task coded
 * `new` would be addressed at `/tasks/new`, which `routeWebRequest` matches as
 * the CREATE FORM before it ever tries to resolve a task, so the task could not
 * be opened at its own code URL. Rejecting the code at the door is the half
 * that stops new ones; `taskPathSegment`'s fallback is the half that copes with
 * codes a store already holds, since validation only ever ran on NEW codes.
 */
describe('validateCode — reserved router segments', () => {
  test('rejects every segment the router reserves', () => {
    for (const seg of RESERVED_TASK_PATH_SEGMENTS) {
      const err = validateCode(seg);
      expect(err, seg).not.toBeNull();
      // The message says WHY, and names the whole reserved set, so the next
      // person does not have to find this list to understand the refusal.
      expect(err, seg).toContain(seg);
      expect(err, seg).toContain('reserved');
    }
  });

  test('the reserved set is exactly the router segments it is derived from', () => {
    const reserved: string[] = [...RESERVED_TASK_PATH_SEGMENTS];
    expect(reserved.slice().sort()).toEqual(
      [TASK_PATH_SEGMENT_NEW, TASK_PATH_SEGMENT_LINK].sort(),
    );
    expect(isReservedTaskPathSegment(TASK_PATH_SEGMENT_NEW)).toBe(true);
    expect(isReservedTaskPathSegment(TASK_PATH_SEGMENT_LINK)).toBe(true);
  });

  test('a code merely containing a reserved word is fine — only the whole segment collides', () => {
    expect(validateCode('new-parser')).toBeNull();
    expect(validateCode('relink')).toBeNull();
    expect(validateCode('link-checker')).toBeNull();
    expect(isReservedTaskPathSegment('new-parser')).toBe(false);
  });
});
