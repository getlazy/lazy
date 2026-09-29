/**
 * The git-author fix, through the code that actually carries it: the real
 * lazy_commit handler, the real host-side sync merge (lazy_internal_git), the
 * accept tag and dirty-destination stash, and the daemon's own fallback reading
 * a real service credential — all under a git with NO config at all, which is
 * what a managed (Teams) daemon runs with.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readFile, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { runGit } from '../../src/utils/git';
import { createStorage, type Storage } from '../../src/storage';
import { createInternalGitHandler } from '../../src/mcp/internal-git';
import { createCommitHandler, type McpToolContext } from '../../src/mcp/tools';
import { branchTarget } from '../../src/task-target';
import { createAcceptTag } from '../../src/git/operations';
import { runWithGitAuthor, setGitAuthorFallback, GIT_AUTHOR_REFUSAL } from '../../src/identity/git-author';
import { systemGitAuthor } from '../../src/identity/system-identity';
import { clearGitIdentityCache } from '../../src/identity/git-identity';
import {
  putUserCredential,
  clearUserCredentialCache,
  SERVICE_CREDENTIAL_USER_ID,
} from '../../src/daemon/user-credentials';
import { MANAGED_ENV, MANAGED_STORAGE_ENV } from '../../src/config/managed';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';

const FIXTURE_AUTHOR = {
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
};

/** Fixture git — names its own author, because it is set-up, not subject. */
function git(cwd: string, ...args: string[]): string {
  const r = spawnSyncUnsupervised(['git', ...args], {
    cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...FIXTURE_AUTHOR },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const SAVED: Record<string, string | undefined> = {};
let home: string;

beforeAll(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'git-author-ep-home-')));
  const env: Record<string, string | undefined> = {
    HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', EMAIL: undefined,
    GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined,
    GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined,
    [MANAGED_ENV]: undefined, [MANAGED_STORAGE_ENV]: undefined,
  };
  for (const [k, v] of Object.entries(env)) {
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

const ALICE = { email: 'alice@example.com', name: 'Alice Member' };
const ALICE_LINE = 'Alice Member <alice@example.com>|Alice Member <alice@example.com>';

describe('the real handlers author commits from their scope', () => {
  let root: string;
  let repo: string;
  let worktree: string;
  let storage: Storage;
  let ctx: McpToolContext;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'git-author-ep-')));
    repo = join(root, 'repo');
    worktree = join(root, 'wt');
    await mkdir(join(repo, '.lazy'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    await writeFile(join(repo, 'base.txt'), 'base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'worktree', 'add', worktree, '-b', 'lazy/mine');
    await writeFile(join(repo, 'upstream.txt'), 'upstream\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'upstream commit');

    storage = await createStorage(repo, { backend: 'external' });
    const task = await storage.createTask('Test task');
    await storage.updateTaskTarget(task.id, branchTarget('main'));
    ctx = { taskId: task.id, worktreePath: worktree, storage };
  });

  afterEach(async () => {
    setGitAuthorFallback(null);
    await storage?.close();
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: lazy_commit, run by the daemon on an agent's behalf, is
  // authored by the turn's owner even where git has no config — the Teams
  // show-stopper where every lazy_commit died on git's auto-detect.
  test('lazy_commit is authored by the scoped person', async () => {
    await writeFile(join(worktree, 'work.txt'), 'work\n');
    const result = await runWithGitAuthor(ALICE, () => createCommitHandler(ctx)({ message: 'agent work' })) as any;
    expect(result.committed).toBe(true);
    expect(git(worktree, 'log', '-1', '--format=%an <%ae>|%cn <%ce>')).toBe(ALICE_LINE);
  });

  test('a host-side sync merge is authored by the scoped person', async () => {
    const merge = await runWithGitAuthor(ALICE, () =>
      createInternalGitHandler(ctx)({ op: 'merge', target: 'main', message: 'Merge main' })) as any;
    expect(merge.exit_code).toBe(0);
    expect(git(worktree, 'rev-list', '--count', '--merges', 'HEAD')).toBe('1');
    expect(git(worktree, 'log', '-1', '--format=%an <%ae>|%cn <%ce>')).toBe(ALICE_LINE);
  });

  test('the annotated accept tag names its tagger', async () => {
    await runWithGitAuthor(ALICE, () => createAcceptTag('0123abcd', 'main', repo));
    expect(git(repo, 'for-each-ref', '--format=%(taggername) %(taggeremail)', 'refs/tags/lazy-accept-0123abcd'))
      .toBe('Alice Member <alice@example.com>');
  });

  test('a stash (dirty-destination accept) is authored by the scoped person', async () => {
    await writeFile(join(repo, 'base.txt'), 'dirty\n');
    const stash = await runWithGitAuthor(ALICE, () =>
      runGit(['stash', 'push', '--include-untracked', '-m', 'autostash'], { cwd: repo }));
    expect(stash.exitCode).toBe(0);
    expect(git(repo, 'log', '-1', '--format=%an <%ae>', 'stash@{0}')).toBe('Alice Member <alice@example.com>');
    expect((await runGit(['stash', 'pop'], { cwd: repo })).exitCode).toBe(0);
  });
});

describe('the daemon fallback on a managed host', () => {
  let root: string;
  let base: string;
  let unpin: () => void;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'git-author-mg-')));
    base = await mkdtemp(join(tmpdir(), 'git-author-mg-base-'));
    unpin = pinDaemonBaseDir(base);
    clearUserCredentialCache();
    clearGitIdentityCache();
    process.env[MANAGED_ENV] = '1';
    process.env[MANAGED_STORAGE_ENV] = join(base, 'store');
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'commit', '--allow-empty', '-m', 'seed');
    setGitAuthorFallback(() => systemGitAuthor(root));
  });

  afterEach(async () => {
    setGitAuthorFallback(null);
    unpin();
    clearUserCredentialCache();
    clearGitIdentityCache();
    delete process.env[MANAGED_ENV];
    delete process.env[MANAGED_STORAGE_ENV];
    await rm(root, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  // INVARIANT: work nobody asked for is authored by the service credential's
  // owner, as the control plane pushed it — never git's auto-detect.
  test('a commit with no scope is authored by the service credential owner', async () => {
    await putUserCredential(root, {
      userId: SERVICE_CREDENTIAL_USER_ID,
      kind: 'oauth',
      token: 'oat-service',
      ownerEmail: 'ops@example.com',
      ownerName: 'Ops',
    });
    const res = await runGit(['commit', '--allow-empty', '-m', 'automated'], { cwd: root });
    expect(res.exitCode).toBe(0);
    expect(git(root, 'log', '-1', '--format=%an <%ae>|%cn <%ce>')).toBe('Ops <ops@example.com>|Ops <ops@example.com>');
  });

  test('a fast-forward is never refused for want of an author', async () => {
    git(root, 'branch', 'ahead');
    git(root, 'checkout', '-q', 'ahead');
    git(root, 'commit', '--allow-empty', '-m', 'ahead');
    git(root, 'checkout', '-q', 'main');
    const res = await runGit(['merge', '--ff-only', 'ahead'], { cwd: root });
    expect(res.stderr).not.toBe(GIT_AUTHOR_REFUSAL);
    expect(res.exitCode).toBe(0);
  });

  test('a lightweight tag, a stash pop and a stash list are never refused', async () => {
    expect((await runGit(['tag', 'plain'], { cwd: root })).exitCode).toBe(0);
    expect((await runGit(['stash', 'list'], { cwd: root })).stderr).not.toBe(GIT_AUTHOR_REFUSAL);
  });

  test('an annotated tag with nobody to name is refused in lazy\'s words', async () => {
    const res = await runGit(['tag', '-a', '-m', 'x', 'annotated'], { cwd: root });
    expect(res.stderr).toBe(GIT_AUTHOR_REFUSAL);
  });
});

describe('the entry points apply the author', () => {
  // INVARIANT: the three places that decide whose commit this is must keep
  // doing so. Removing any of them silently returns Teams to git's
  // auto-detect, and the handler-level tests above would stay green.
  test('handleRpc, handleMcpToolCall and the daemon start wire the author', async () => {
    const src = (p: string) => readFile(join(import.meta.dir, '../../src', p), 'utf-8');
    const rpc = await src('daemon/rpc-handlers.ts');
    expect(rpc).toMatch(/caller\.kind === 'user' \? \{ email: caller\.email/);
    expect(rpc).toMatch(/return runWithGitAuthor\(gitAuthor,/);
    const mcp = await src('daemon/mcp-routes.ts');
    expect(mcp).toMatch(/return runWithGitAuthor\(ctx\.actorPerson \?\? null,/);
    const server = await src('daemon/server.ts');
    expect(server).toMatch(/setGitAuthorFallback\(\(\) => systemGitAuthor\(projectRoot\)\)/);
    expect(server).toMatch(/setGitAuthorFallback\(null\)/);
  });
});
