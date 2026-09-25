/**
 * Unit coverage for the gitignore cascade the LAZY.md nested sweep uses.
 *
 * collectLazyMdFiles integration is in lazy-md.test.ts; these pin the matcher
 * itself so a glob/negation regression cannot hide behind the sweep.
 */

import { describe, test, expect } from 'bun:test';

import { GitIgnoreCascade, parseGitignore } from '../../src/task/lazy-md-gitignore';

describe('parseGitignore', () => {
  test('ignores blanks and comments', () => {
    const rules = parseGitignore('# hi\n\nnode_modules/\n');
    expect(rules).toHaveLength(1);
    expect(rules[0]!.test('node_modules', true)).toBe(true);
  });

  test('unanchored patterns match at any depth', () => {
    const [rule] = parseGitignore('node_modules/\n');
    expect(rule!.test('node_modules', true)).toBe(true);
    expect(rule!.test('packages/foo/node_modules', true)).toBe(true);
    expect(rule!.test('src', true)).toBe(false);
  });

  test('a leading slash anchors at the gitignore directory', () => {
    const [rule] = parseGitignore('/build/\n');
    expect(rule!.test('build', true)).toBe(true);
    expect(rule!.test('pkg/build', true)).toBe(false);
  });

  test('directory-only patterns do not match files', () => {
    const [rule] = parseGitignore('out/\n');
    expect(rule!.test('out', true)).toBe(true);
    expect(rule!.test('out', false)).toBe(false);
  });

  test('negation flips the match for the cascade to honour', () => {
    const rules = parseGitignore('vendor/\n!vendor/kept/\n');
    expect(rules[0]!.negated).toBe(false);
    expect(rules[1]!.negated).toBe(true);
    expect(rules[1]!.test('vendor/kept', true)).toBe(true);
  });

  test('* and ? match within a single path segment', () => {
    const [star] = parseGitignore('*.tmp/\n');
    expect(star!.test('foo.tmp', true)).toBe(true);
    expect(star!.test('foo.tmp/bar', true)).toBe(false);

    const [q] = parseGitignore('d?/\n');
    expect(q!.test('d1', true)).toBe(true);
    expect(q!.test('d12', true)).toBe(false);
  });
});

describe('GitIgnoreCascade', () => {
  test('later rules in the same file override earlier ones', () => {
    const cascade = new GitIgnoreCascade();
    cascade.push('', 'secret/\nvisible/\n!visible/\n');
    expect(cascade.ignores('secret', true)).toBe(true);
    expect(cascade.ignores('visible', true)).toBe(false);
  });

  test('a nested .gitignore only applies below its own directory', () => {
    const cascade = new GitIgnoreCascade();
    cascade.push('', '');
    const nested = cascade.clone();
    nested.push('services', 'generated/\n');
    expect(nested.ignores('services/generated', true)).toBe(true);
    expect(nested.ignores('web/generated', true)).toBe(false);
  });

  test('clone does not share later pushes with the original', () => {
    const a = new GitIgnoreCascade();
    a.push('', 'dist/\n');
    const b = a.clone();
    b.push('pkg', 'build/\n');
    expect(a.ignores('pkg/build', true)).toBe(false);
    expect(b.ignores('pkg/build', true)).toBe(true);
  });
});
