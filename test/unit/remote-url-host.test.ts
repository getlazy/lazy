/**
 * Host extraction for git remote URLs (src/remote/remote-url.ts).
 *
 * The GitHub and GitLab drivers used to answer "is this remote GitHub/GitLab?"
 * with `url.includes('github.com')` — a substring test against the whole URL,
 * which `https://evil.com/github.com/x.git` satisfies. Nothing is trusted based
 * on the answer, but the check should mean what it says.
 */

import { describe, test, expect } from 'bun:test';
import { remoteUrlHost, remoteUrlHasHost, remoteUrlHostContains } from '../../src/remote/remote-url';

describe('remoteUrlHost', () => {
  test('parses scp syntax, which has no scheme and makes new URL() throw', () => {
    // INVARIANT: this repo's own remotes are in scp form. Any host check that
    // cannot parse them silently stops detecting GitHub/GitLab entirely.
    expect(remoteUrlHost('git@github.com:getlazy/lazy.git')).toBe('github.com');
    expect(remoteUrlHost('git@gitlab.mycorp.com:team/repo.git')).toBe('gitlab.mycorp.com');
    expect(remoteUrlHost('github.com:getlazy/lazy.git')).toBe('github.com');
  });

  test('parses https, ssh:// and git:// URLs', () => {
    expect(remoteUrlHost('https://github.com/getlazy/lazy.git')).toBe('github.com');
    expect(remoteUrlHost('ssh://git@github.com/getlazy/lazy.git')).toBe('github.com');
    expect(remoteUrlHost('git://github.com/getlazy/lazy.git')).toBe('github.com');
    expect(remoteUrlHost('https://gitlab.com:8443/team/repo.git')).toBe('gitlab.com');
  });

  test('strips userinfo, so a credential-bearing URL yields only the host', () => {
    expect(remoteUrlHost('https://x-access-token:ghp_secret@github.com/o/r.git')).toBe('github.com');
  });

  test('lowercases the host and returns null when there is none', () => {
    expect(remoteUrlHost('https://GitHub.COM/o/r.git')).toBe('github.com');
    expect(remoteUrlHost('/srv/git/repo.git')).toBeNull();
    expect(remoteUrlHost('')).toBeNull();
    expect(remoteUrlHost('   ')).toBeNull();
  });
});

describe('remoteUrlHasHost', () => {
  test('matches the host exactly or as a subdomain', () => {
    expect(remoteUrlHasHost('https://github.com/o/r.git', 'github.com')).toBe(true);
    expect(remoteUrlHasHost('git@github.com:o/r.git', 'github.com')).toBe(true);
    expect(remoteUrlHasHost('https://www.github.com/o/r.git', 'github.com')).toBe(true);
    expect(remoteUrlHasHost('https://gitlab.com/o/r.git', 'gitlab.com')).toBe(true);
  });

  test('the alert case: a lookalike path does not make it a GitHub remote', () => {
    expect(remoteUrlHasHost('https://evil.com/github.com/x.git', 'github.com')).toBe(false);
    expect(remoteUrlHasHost('git@evil.com:github.com/x.git', 'github.com')).toBe(false);
    expect(remoteUrlHasHost('https://evil.com/gitlab.com/x.git', 'gitlab.com')).toBe(false);
    // A suffix that is not a domain boundary.
    expect(remoteUrlHasHost('https://notgithub.com/o/r.git', 'github.com')).toBe(false);
  });

  test('self-hosted installs are not the vendor host', () => {
    expect(remoteUrlHasHost('https://gitlab.mycorp.com/o/r.git', 'gitlab.com')).toBe(false);
  });
});

describe('remoteUrlHostContains', () => {
  test('keeps the self-hosted escape hatch alive', () => {
    // INVARIANT: gitlab-driver's doctor check deliberately accepts any host
    // mentioning "gitlab" so a self-hosted install does not get a spurious
    // "does not appear to be GitLab" warning. Same for GitHub Enterprise.
    expect(remoteUrlHostContains('https://gitlab.mycorp.com/o/r.git', 'gitlab')).toBe(true);
    expect(remoteUrlHostContains('git@gitlab.internal:o/r.git', 'gitlab')).toBe(true);
    expect(remoteUrlHostContains('https://github.mycorp.com/o/r.git', 'github')).toBe(true);
  });

  test('unlike the old substring test, a path segment does not qualify', () => {
    expect(remoteUrlHostContains('https://evil.com/gitlab/x.git', 'gitlab')).toBe(false);
    expect(remoteUrlHostContains('/srv/git/gitlab/repo.git', 'gitlab')).toBe(false);
  });
});
