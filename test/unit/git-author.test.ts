import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runGit } from '../../src/utils/git';
import { mergeBranch, squashMergeBranchIntoTarget } from '../../src/git/operations';
import { runWithGitAuthor, setGitAuthorFallback, GIT_AUTHOR_REFUSAL } from '../../src/identity/git-author';
import { systemGitAuthor } from '../../src/identity/system-identity';
import { clearGitIdentityCache } from '../../src/identity/git-identity';

// A managed (Teams) daemon runs with NO git config. Every test here runs git
// under exactly that: no global, no system config, an empty HOME, and no
// EMAIL/author env to fall back on — so git's auto-detect is what would answer.
const SAVED: Record<string, string | undefined> = {};
const EMPTY_GIT_ENV: Record<string, string | undefined> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: undefined,
  GIT_AUTHOR_EMAIL: undefined,
  GIT_COMMITTER_NAME: undefined,
  GIT_COMMITTER_EMAIL: undefined,
  EMAIL: undefined,
  LAZY_MANAGED: undefined,
};

let root: string;
let home: string;

async function author(ref = 'HEAD'): Promise<string> {
  return (await runGit(['log', '-1', '--format=%an <%ae>|%cn <%ce>', ref], { cwd: root })).stdout;
}

async function commitFile(name: string, message: string, env?: Record<string, string>): Promise<void> {
  await writeFile(join(root, name), `${name}\n`);
  await runGit(['add', name], { cwd: root });
  const res = await runGit(['commit', '-m', message], { cwd: root, env });
  if (res.exitCode !== 0) throw new Error(res.stderr);
}

beforeAll(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'git-author-home-')));
  for (const [k, v] of Object.entries({ ...EMPTY_GIT_ENV, HOME: home })) {
    SAVED[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

afterAll(async () => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  await rm(home, { recursive: true, force: true });
});

async function freshRepo(): Promise<void> {
  root = await realpath(await mkdtemp(join(tmpdir(), 'git-author-repo-')));
  await runGit(['init', '-q', '-b', 'main'], { cwd: root });
  // The seed commit names its author explicitly: it is fixture, not subject.
  await commitFile('seed.txt', 'seed', {
    GIT_AUTHOR_NAME: 'Seed', GIT_AUTHOR_EMAIL: 'seed@example.com',
    GIT_COMMITTER_NAME: 'Seed', GIT_COMMITTER_EMAIL: 'seed@example.com',
  });
}

afterEach(async () => {
  setGitAuthorFallback(null);
  delete process.env.LAZY_MANAGED;
  clearGitIdentityCache();
  await rm(root, { recursive: true, force: true });
});

const ALICE = { email: 'alice@example.com', name: 'Alice Member' };

describe('daemon-side git writes name their author explicitly', () => {
  // INVARIANT: a commit lazy makes on someone's behalf (lazy_commit) is
  // authored AND committed by the person whose scope it runs in — on a host
  // with no git config at all. Without it every lazy_commit on a Teams install
  // failed with git's "unable to auto-detect email address".
  test('a commit (lazy_commit) inside a scope is authored by that person', async () => {
    await freshRepo();
    await runWithGitAuthor(ALICE, () => commitFile('a.txt', 'agent work'));
    expect(await author()).toBe('Alice Member <alice@example.com>|Alice Member <alice@example.com>');
  });

  test('a sync merge (--no-ff) inside a scope is authored by that person', async () => {
    await freshRepo();
    await runGit(['checkout', '-q', '-b', 'feature'], { cwd: root });
    await runWithGitAuthor(ALICE, () => commitFile('f.txt', 'feature'));
    await runGit(['checkout', '-q', 'main'], { cwd: root });
    await runWithGitAuthor(ALICE, () => commitFile('m.txt', 'main moves'));
    await runWithGitAuthor(ALICE, () => mergeBranch('feature', root));
    expect(await runGit(['rev-list', '--parents', '-n1', 'HEAD'], { cwd: root }).then((r) => r.stdout.split(' ').length)).toBe(3);
    expect(await author()).toBe('Alice Member <alice@example.com>|Alice Member <alice@example.com>');
  });

  test('an accept squash with no scope is authored by the configured system identity', async () => {
    await freshRepo();
    await runGit(['checkout', '-q', '-b', 'task'], { cwd: root });
    await runWithGitAuthor(ALICE, () => commitFile('t.txt', 'task work'));
    await runGit(['checkout', '-q', 'main'], { cwd: root });
    const service = { email: 'owner@example.com', name: 'Service Owner' };
    setGitAuthorFallback(async () => ({ author: service }));
    await squashMergeBranchIntoTarget('task', 'main', 'Accept task', root);
    expect(await author()).toBe('Service Owner <owner@example.com>|Service Owner <owner@example.com>');
  });

  // INVARIANT: on a managed host with nobody to name, lazy refuses in its own
  // words BEFORE git runs — never git's auto-detect message, and never a
  // guessed author.
  test('managed mode with no identity refuses in lazy\'s words before git runs', async () => {
    await freshRepo();
    process.env.LAZY_MANAGED = '1';
    setGitAuthorFallback(() => systemGitAuthor(root));
    await writeFile(join(root, 'x.txt'), 'x\n');
    await runGit(['add', 'x.txt'], { cwd: root });
    const res = await runGit(['commit', '-m', 'nobody'], { cwd: root });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toBe(GIT_AUTHOR_REFUSAL);
    expect(res.stderr).toContain('Please tell me who you are');
    expect(await runGit(['log', '--format=%s'], { cwd: root }).then((r) => r.stdout)).toBe('seed');
  });

  test('leaving a merge in progress is never refused for want of an author', async () => {
    await freshRepo();
    process.env.LAZY_MANAGED = '1';
    setGitAuthorFallback(() => systemGitAuthor(root));
    const res = await runGit(['merge', '--abort'], { cwd: root });
    expect(res.stderr).not.toBe(GIT_AUTHOR_REFUSAL);
  });

  // On a laptop the daemon's git config still answers: the fallback resolves
  // it and passes it through unchanged.
  test('a laptop with repo git config keeps authoring as that config', async () => {
    await freshRepo();
    await runGit(['config', 'user.email', 'dev@example.com'], { cwd: root });
    await runGit(['config', 'user.name', 'Dev'], { cwd: root });
    setGitAuthorFallback(() => systemGitAuthor(root));
    await commitFile('l.txt', 'laptop');
    expect(await author()).toBe('Dev <dev@example.com>|Dev <dev@example.com>');
  });
});
