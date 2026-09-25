import { describe, test, expect } from 'bun:test';
import { parseLinkTarget, assertSafeGitName } from '../../src/remote/link-target';

describe('parseLinkTarget', () => {
  test('classifies a GitHub pull request URL', () => {
    const t = parseLinkTarget('https://github.com/acme/repo/pull/42');
    expect(t).toEqual({
      kind: 'pr-url',
      raw: 'https://github.com/acme/repo/pull/42',
    });
  });

  test('classifies a GitLab merge request URL', () => {
    const t = parseLinkTarget('https://gitlab.com/acme/repo/-/merge_requests/9');
    expect(t.kind).toBe('pr-url');
  });

  test('classifies a GitHub tree URL, including slashes in the branch', () => {
    const t = parseLinkTarget('https://github.com/acme/repo/tree/feature/auth');
    expect(t).toEqual({
      kind: 'branch-url',
      raw: 'https://github.com/acme/repo/tree/feature/auth',
      branch: 'feature/auth',
    });
  });

  test('classifies a GitLab tree URL', () => {
    const t = parseLinkTarget('https://gitlab.com/acme/repo/-/tree/feature/auth');
    expect(t.kind).toBe('branch-url');
    expect(t.branch).toBe('feature/auth');
  });

  test('decodes percent-encoded slashes in a branch URL', () => {
    const t = parseLinkTarget('https://github.com/acme/repo/tree/feat%2Fwith-dash');
    expect(t.kind).toBe('branch-url');
    expect(t.branch).toBe('feat/with-dash');
  });

  test('rejects a decoded branch that is not a legal git ref', () => {
    expect(() => parseLinkTarget('https://github.com/acme/repo/tree/feat%2Fwith%20space'))
      .toThrow(/character git does not allow/);
  });

  test('rejects a dash-prefixed branch that git would parse as an option', () => {
    expect(() => parseLinkTarget('--upload-pack=evil')).toThrow(/starting with '-'/);
    expect(() => parseLinkTarget('origin/--upload-pack=evil')).toThrow(/starting with '-'/);
  });

  test('rejects a dash-prefixed remote even when it is in the known-remote list', () => {
    expect(() => parseLinkTarget('--upload-pack=evil/feature', ['--upload-pack=evil']))
      .toThrow(/starting with '-'/);
  });

  test('rejects a dash-prefixed component after a remote prefix', () => {
    expect(() => parseLinkTarget('origin/--upload-pack=evil')).toThrow(/starting with '-'/);
  });

  test('rejects a branch URL whose path is a git option', () => {
    expect(() => parseLinkTarget('https://github.com/acme/repo/tree/--upload-pack=evil'))
      .toThrow(/starting with '-'/);
  });

  test('treats a bare name as a branch', () => {
    expect(parseLinkTarget('feature/auth')).toEqual({
      kind: 'branch',
      raw: 'feature/auth',
      branch: 'feature/auth',
    });
  });

  test('splits origin/branch only when origin is a known remote', () => {
    const t = parseLinkTarget('origin/feature/auth');
    expect(t).toEqual({
      kind: 'branch',
      raw: 'origin/feature/auth',
      branch: 'feature/auth',
      remote: 'origin',
    });
  });

  test('does not treat feature/auth as remote+branch', () => {
    const t = parseLinkTarget('feature/auth', ['origin', 'upstream']);
    expect(t.branch).toBe('feature/auth');
    expect(t.remote).toBeUndefined();
  });

  test('honours an extra known remote', () => {
    const t = parseLinkTarget('fork/hotfix', ['origin', 'fork']);
    expect(t.branch).toBe('hotfix');
    expect(t.remote).toBe('fork');
  });

  test('rejects an empty string', () => {
    expect(() => parseLinkTarget('   ')).toThrow(/required/);
  });

  test('rejects an http URL that is neither a PR nor a tree page', () => {
    expect(() => parseLinkTarget('https://github.com/acme/repo'))
      .toThrow(/not a pull request, merge request, or branch page/);
  });

  test('rejects a issues URL', () => {
    expect(() => parseLinkTarget('https://github.com/acme/repo/issues/12'))
      .toThrow(/not a pull request/);
  });
});

describe('assertSafeGitName', () => {
  test('accepts ordinary branch and remote names', () => {
    expect(() => assertSafeGitName('feature/auth', 'branch')).not.toThrow();
    expect(() => assertSafeGitName('main', 'branch')).not.toThrow();
    expect(() => assertSafeGitName('origin', 'remote')).not.toThrow();
  });

  test('refuses option-shaped names', () => {
    expect(() => assertSafeGitName('--upload-pack=evil', 'branch')).toThrow(/starting with '-'/);
    expect(() => assertSafeGitName('--upload-pack=evil', 'remote')).toThrow(/starting with '-'/);
    expect(() => assertSafeGitName('-branch', 'branch')).toThrow(/starting with '-'/);
  });

  test('refuses git-illegal ref characters', () => {
    expect(() => assertSafeGitName('foo..bar', 'branch')).toThrow(/\.\./);
    expect(() => assertSafeGitName('foo@{bar', 'branch')).toThrow(/@\{/);
    expect(() => assertSafeGitName('foo bar', 'branch')).toThrow(/character git does not allow/);
  });
});
