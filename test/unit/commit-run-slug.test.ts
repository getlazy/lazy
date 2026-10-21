/**
 * The names a commit run goes by (src/run/identity.ts).
 *
 * INVARIANT: a run's slug is always a DNS label short enough to sit in the
 * `<slug>--<service>--p<id>` service hostname, a sha run's slug cannot be
 * mistaken for a branch's default, and the checkout path and container name
 * are only ever derived from a slug lazy could have produced — a tampered row
 * cannot point lazy at a directory to delete or a container to remove.
 */

import { describe, test, expect } from 'bun:test';
import {
  branchRunSlug,
  shaRunSlug,
  isRunSlug,
  runSlugFor,
  runWorktreePath,
  runContainerName,
  sameRunTarget,
  isShaLike,
  MAX_BRANCH_SLUG_LENGTH,
  RUN_WORKTREE_PREFIX,
} from '../../src/run/identity';

describe('run slugs', () => {
  test('a branch slug is the branch name made into a label', () => {
    expect(branchRunSlug('main')).toBe('main');
    expect(branchRunSlug('feature/Login.v2')).toBe('feature-login-v2');
    expect(branchRunSlug('lazy/fix-it')).toBe('lazy-fix-it');
    expect(branchRunSlug('--weird__name--')).toBe('weird-name');
  });

  test(`a branch slug is at most ${MAX_BRANCH_SLUG_LENGTH} characters and never ends in a hyphen`, () => {
    const slug = branchRunSlug(`${'a'.repeat(39)}-${'b'.repeat(30)}`);
    expect(slug.length).toBeLessThanOrEqual(MAX_BRANCH_SLUG_LENGTH);
    expect(slug.endsWith('-')).toBe(false);
    expect(isRunSlug(slug)).toBe(true);
  });

  test('a branch with nothing usable in its name still gets a label', () => {
    const slug = branchRunSlug('___');
    expect(slug).toMatch(/^branch-[0-9a-f]{8}$/);
    expect(isRunSlug(slug)).toBe(true);
  });

  test('a sha slug is sha- and its first 12 hex digits', () => {
    expect(shaRunSlug('1A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D7E8F9A0B')).toBe('sha-1a2b3c4d5e6f');
    expect(runSlugFor({ kind: 'sha', sha: 'abcdef0123456789abcdef0123456789abcdef01' })).toBe('sha-abcdef012345');
    expect(runSlugFor({ kind: 'branch', branch: 'release/1.0' })).toBe('release-1-0');
  });

  test('every slug fits the service hostname label with room to spare', () => {
    for (const slug of [branchRunSlug('x'.repeat(200)), shaRunSlug('f'.repeat(40))]) {
      expect(isRunSlug(slug)).toBe(true);
      // `<slug>--<service>--p<id>`: a 40-char slug leaves 23 for the rest.
      expect(slug.length).toBeLessThanOrEqual(MAX_BRANCH_SLUG_LENGTH);
    }
  });

  test('sha-like input is 7 to 40 hex', () => {
    expect(isShaLike('abc1234')).toBe(true);
    expect(isShaLike('ABC1234')).toBe(true);
    expect(isShaLike('abc123')).toBe(false);
    expect(isShaLike('xyz1234')).toBe(false);
    expect(isShaLike('a'.repeat(41))).toBe(false);
  });

  test('targets are the same only when they name the same branch or commit', () => {
    expect(sameRunTarget({ kind: 'branch', branch: 'main' }, { kind: 'branch', branch: 'main' })).toBe(true);
    expect(sameRunTarget({ kind: 'branch', branch: 'feature/x' }, { kind: 'branch', branch: 'feature-x' })).toBe(false);
    expect(sameRunTarget({ kind: 'sha', sha: 'ABC' }, { kind: 'sha', sha: 'abc' })).toBe(true);
    expect(sameRunTarget({ kind: 'sha', sha: 'abc' }, { kind: 'branch', branch: 'abc' })).toBe(false);
  });
});

describe('derived names', () => {
  test('the checkout lives under the worktrees dir with a prefix no task code can have', () => {
    expect(runWorktreePath('/p', 'main')).toBe(`/p/.lazy/worktrees/${RUN_WORKTREE_PREFIX}main`);
    expect(RUN_WORKTREE_PREFIX.startsWith('lazy-')).toBe(true);
  });

  test('container names differ per project, so two projects can both run main', () => {
    expect(runContainerName('/a', 'main')).not.toBe(runContainerName('/b', 'main'));
    expect(runContainerName('/a', 'main')).toMatch(/^lazyrun-main-[0-9a-f]{8}$/);
  });

  test('a slug lazy could not have produced is refused, not turned into a path or a name', () => {
    for (const bad of ['../etc', 'a/b', '', 'Main', '-x', 'x-']) {
      expect(() => runWorktreePath('/p', bad)).toThrow();
      expect(() => runContainerName('/p', bad)).toThrow();
    }
  });
});
