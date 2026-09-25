/**
 * The git-config identity resolver (src/identity/git-identity.ts).
 *
 * What is pinned here is what a person experiences: git's precedence is git's
 * (a repo-local address wins), a missing identity is an ANSWER rather than a
 * crash, and — the one that matters most — a FAILURE is never cached, so
 * fixing your git config takes effect on the very next command instead of a
 * minute later or after a daemon restart.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  clearGitIdentityCache,
  describeIdentity,
  resolveGitIdentity,
  IDENTITY_REFUSAL,
} from '../../src/identity';
import { runGit } from '../../src/utils/git';

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lazy-git-identity-'));
  await runGit(['init'], { cwd: dir });
  // A fresh repo with no identity of its OWN — the global config of whoever
  // runs this suite still applies, which is why the "unconfigured" cases below
  // shadow it explicitly (see withNoIdentity).
  return dir;
}

/**
 * Make this repository look like a machine with no identity configured.
 *
 * NOT by unsetting `GIT_CONFIG_GLOBAL` in `process.env`: Bun snapshots the
 * environment when the process starts, so a mutation here never reaches a
 * spawned git and the developer's own `~/.gitconfig` leaks into the assertion.
 * A repo-local EMPTY value shadows every outer level instead — which is also a
 * state a real repository can be in, and one git itself refuses to commit
 * under ("empty ident name not allowed").
 */
async function withNoIdentity(dir: string): Promise<void> {
  await runGit(['config', 'user.email', ''], { cwd: dir });
  await runGit(['config', 'user.name', ''], { cwd: dir });
}

describe('git identity resolution', () => {
  let root: string;

  beforeEach(async () => {
    root = await initRepo();
    clearGitIdentityCache();
  });

  afterEach(async () => {
    clearGitIdentityCache();
    delete process.env.LAZY_MANAGED;
    await rm(root, { recursive: true, force: true });
  });

  test('resolves the repository-local identity', async () => {
    await runGit(['config', 'user.email', 'ada@example.com'], { cwd: root });
    await runGit(['config', 'user.name', 'Ada Lovelace'], { cwd: root });

    const resolution = await resolveGitIdentity(root);

    expect(resolution.configured).toBe(true);
    if (!resolution.configured) throw new Error('unreachable');
    expect(resolution.identity).toEqual({ email: 'ada@example.com', name: 'Ada Lovelace' });
  });

  test('a person with no user.name is still a person', async () => {
    await withNoIdentity(root);
    await runGit(['config', 'user.email', 'ada@example.com'], { cwd: root });

    const resolution = await resolveGitIdentity(root);

    expect(resolution.configured).toBe(true);
    if (!resolution.configured) throw new Error('unreachable');
    expect(resolution.identity.email).toBe('ada@example.com');
    expect(resolution.identity.name).toBeUndefined();
  });

  test('an unset user.email answers with git\'s own refusal', async () => {
    await withNoIdentity(root);

    const resolution = await resolveGitIdentity(root);

    expect(resolution.configured).toBe(false);
    if (resolution.configured) throw new Error('unreachable');
    expect(resolution.failure).toEqual({ reason: 'unset' });
    expect(resolution.refusal).toBe(IDENTITY_REFUSAL);
    expect(resolution.refusal).toContain('Please tell me who you are');
  });

  test('a user.email that is not an address is refused, and says so', async () => {
    await runGit(['config', 'user.email', 'ada'], { cwd: root });

    const resolution = await resolveGitIdentity(root);

    expect(resolution.configured).toBe(false);
    if (resolution.configured) throw new Error('unreachable');
    expect(resolution.failure).toEqual({ reason: 'not-an-address', value: 'ada' });
    // Both halves: git's remedy, plus the sentence that explains why a value
    // git accepts is not one lazy can store.
    expect(resolution.refusal).toContain('Please tell me who you are');
    expect(resolution.refusal).toContain('not an email address');
  });

  // INVARIANT: a SUCCESS is cached for a minute; a FAILURE is never cached.
  // Someone who has just been refused and fixed their git config must be
  // believed immediately — otherwise the remedy appears not to work, and the
  // only way out is restarting a daemon they should never have to think about.
  test('a failure is not cached — the fix takes effect on the next call', async () => {
    await withNoIdentity(root);
    const refused = await resolveGitIdentity(root);
    expect(refused.configured).toBe(false);

    await runGit(['config', 'user.email', 'ada@example.com'], { cwd: root });

    const after = await resolveGitIdentity(root);
    expect(after.configured).toBe(true);
  });

  // The other half of the same rule: a success IS cached, so a store write does
  // not pay for a subprocess every time. Observable as the stale answer a
  // change inside the TTL produces.
  test('a success is cached for the TTL', async () => {
    await runGit(['config', 'user.email', 'ada@example.com'], { cwd: root });
    const first = await resolveGitIdentity(root);
    expect(first.configured).toBe(true);

    await runGit(['config', 'user.email', 'grace@example.com'], { cwd: root });
    const second = await resolveGitIdentity(root);

    expect(second.configured).toBe(true);
    if (!second.configured) throw new Error('unreachable');
    expect(second.identity.email).toBe('ada@example.com');

    clearGitIdentityCache();
    const third = await resolveGitIdentity(root);
    if (!third.configured) throw new Error('unreachable');
    expect(third.identity.email).toBe('grace@example.com');
  });

  // INVARIANT: in managed mode the environment names nobody, so git config is
  // not consulted at all — every request carries its own identity on its token.
  test('managed mode never consults git config', async () => {
    process.env.LAZY_MANAGED = '1';

    await withNoIdentity(root);

    const answer = await describeIdentity(root);

    expect(answer).toEqual({ mode: 'teams', configured: true });
  });

  test('describeIdentity reports the person on a laptop', async () => {
    await runGit(['config', 'user.email', 'ada@example.com'], { cwd: root });
    await runGit(['config', 'user.name', 'Ada'], { cwd: root });

    const answer = await describeIdentity(root);

    expect(answer).toEqual({
      mode: 'single-person',
      configured: true,
      email: 'ada@example.com',
      name: 'Ada',
    });
  });
});
