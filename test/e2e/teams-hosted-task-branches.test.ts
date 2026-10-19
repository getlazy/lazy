/**
 * A Teams-run (managed) project on the local driver — what a repository the
 * install hosts itself gets — mirrors task branches to origin: the after-turn
 * push lands `lazy/<task>` there, and a member's push to it is merged by
 * `lazy sync`, and an accept pushes its target (`main`) there. Drives a real daemon restarted in managed mode, with a bare
 * repository standing in for the install's hosted git.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { storageDirFor, readTaskStatus, readTaskJson } from '../helpers/storage';
import { turnProtectionOff } from '../helpers/managed-protection';
import { createTask, withPresentedToken, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { runGit } from '../../src/utils/git';
import { seedFinal } from '../helpers/final';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runGit(args, { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${r.stderr}`);
  return r.stdout.trim();
}

describe('task branches on a Teams-hosted origin', () => {
  let ctx: TestContext;
  let side: string;
  let hosted: string;
  let alice: string;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    side = await mkdtemp(join(tmpdir(), 'lazy-hosted-origin-'));
    hosted = join(side, 'hosted.git');
    await runGit(['init', '-q', '--bare', '-b', 'main', hosted], { cwd: side });
    const branch = await git(ctx.root, 'rev-parse', '--abbrev-ref', 'HEAD');
    await git(ctx.root, 'remote', 'add', 'origin', hosted);
    await git(ctx.root, 'push', '-q', 'origin', `${branch}:main`);
    const controlConfig = join(side, 'lazy.toml');
    await writeFile(controlConfig, await readFile(join(ctx.root, 'lazy.toml'), 'utf8'));
    // Protection is not what this suite tests; see test/helpers/managed-protection.ts.
    await turnProtectionOff(controlConfig);
    await ctx.restartDaemon({
      LAZY_TEST_FORCE_MANAGED: '1',
      LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
      LAZY_MANAGED_CONFIG_PATH: controlConfig,
    });
    const target = getDaemonTcpTarget(ctx.root), token = readToken(ctx.root);
    if (!target || !token) throw new Error('test daemon did not record a TCP target and token');
    const control = DaemonClient.fromTarget(target, token);
    await control.rpc('putUserCredential', ctx.root, { userId: 'ada@example.com', kind: 'oauth', token: 'sk-ant-oat01-test' });
    alice = ((await control.rpc('mintActorToken', ctx.root, { kind: 'user', email: 'ada@example.com', name: 'Ada' })) as { token: string }).token;
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(side, { recursive: true, force: true });
  });

  // INVARIANT: after a turn, the task's branch is on origin (the same
  // after-turn push forge projects use), and a member's push to it is merged
  // into the task branch by `lazy sync` (sync's step 1).
  test('a finished turn lands lazy/<task> on origin; a member push is merged by sync', async () => {
    const taskId = await createTask(ctx, 'Hosted branch', 'Some work', { token: alice });
    const start = await withPresentedToken(ctx, alice, () => ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    expect(start.exitCode).toBe(0);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    const show = await ctx.lazy(['show', taskId, '--json']);
    const branch = (JSON.parse(show.stdout) as { session: { git_branch: string } }).session.git_branch;

    let onOrigin = '';
    for (let i = 0; i < 60 && !onOrigin; i++) {
      onOrigin = (await runGit(['ls-remote', hosted, `refs/heads/${branch}`], { cwd: side })).stdout.trim();
      if (!onOrigin) await Bun.sleep(500);
    }
    expect(onOrigin).toContain(branch);

    const member = join(side, 'member');
    await runGit(['clone', '-q', '-b', branch, hosted, member], { cwd: side });
    await git(member, 'config', 'user.email', 'ada@example.com');
    await git(member, 'config', 'user.name', 'Ada');
    await writeFile(join(member, 'mac.txt'), 'built on the mac\n');
    await git(member, 'add', '.');
    await git(member, 'commit', '-q', '-m', 'tested on the mac');
    const pushed = await git(member, 'rev-parse', 'HEAD');
    await git(member, 'push', '-q', 'origin', branch);

    const sync = await withPresentedToken(ctx, alice, () => ctx.lazyMocked(['sync', taskId], MOCK_CLAUDE_SUCCESS));
    if (sync.exitCode !== 0) throw new Error(sync.stderr + sync.stdout);
    expect(sync.exitCode).toBe(0);
    await ctx.lazy(['wait', taskId]);
    const contains = await runGit(['merge-base', '--is-ancestor', pushed, branch], { cwd: ctx.root });
    expect(contains.exitCode).toBe(0);
  }, 120_000);

  // INVARIANT: the browser's "Move under another task" accepts a branch a
  // member pushed to the team's repository, which the daemon clone has only on
  // origin — the same rule `lazy create --parent <branch>` resolves through.
  test('a task can be moved under a branch that exists only on origin', async () => {
    const taskId = await createTask(ctx, 'Moved', 'Some work', { token: alice });
    const member = join(side, 'mover');
    await runGit(['clone', '-q', hosted, member], { cwd: side });
    await git(member, 'push', '-q', 'origin', 'HEAD:refs/heads/pushed/base');
    expect((await runGit(['rev-parse', '--verify', '--quiet', 'refs/heads/pushed/base'], { cwd: ctx.root })).exitCode).not.toBe(0);

    const moved = await withPresentedToken(ctx, alice, () => ctx.lazyMocked(['reparent', taskId, '--parent', 'pushed/base', '--yes'], MOCK_CLAUDE_SUCCESS));
    if (moved.exitCode !== 0) throw new Error(moved.stderr + moved.stdout);
    expect(readTaskJson(ctx.root, taskId).target).toEqual({ kind: 'branch', branch: 'pushed/base' });
    expect((await runGit(['rev-parse', '--verify', '--quiet', 'refs/heads/pushed/base'], { cwd: ctx.root })).exitCode).toBe(0);
  }, 120_000);

  async function finishedTaskWithCommit(goal: string): Promise<string> {
    const taskId = await createTask(ctx, goal, 'Some work', { token: alice });
    const start = await withPresentedToken(ctx, alice, () => ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    expect(start.exitCode).toBe(0);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);
    const worktree = join(ctx.root, '.lazy', 'worktrees', taskId);
    await writeFile(join(worktree, 'accepted.txt'), 'accepted work\n');
    await git(worktree, 'add', 'accepted.txt');
    await git(worktree, 'commit', '-q', '-m', 'Add accepted work');
    await seedFinal(ctx, taskId);
    return taskId;
  }

  async function taskStatus(taskId: string): Promise<string> {
    return readTaskStatus(ctx.root, taskId);
  }

  // INVARIANT: on a Teams-hosted project, accepted work reaches the install's
  // `main` — the accept's follow-through pushes the target, so a member's
  // `git fetch` sees it like on a forge.
  test('accept pushes main to the hosted origin', async () => {
    const taskId = await finishedTaskWithCommit('Hosted accept');
    const accept = await withPresentedToken(ctx, alice, () => ctx.lazy(['accept', taskId, '--yes']));
    if (accept.exitCode !== 0) throw new Error(accept.stderr + accept.stdout);
    const localMain = await git(ctx.root, 'rev-parse', 'main');
    const originMain = (await runGit(['rev-parse', 'main'], { cwd: hosted })).stdout.trim();
    expect(originMain).toBe(localMain);
    const tree = await git(hosted, 'ls-tree', '--name-only', 'main');
    expect(tree.split('\n')).toContain('accepted.txt');
  }, 120_000);

  async function pushDirectlyToHostedMain(file: string): Promise<string> {
    const member = join(side, 'direct');
    await runGit(['clone', '-q', '-b', 'main', hosted, member], { cwd: side });
    await git(member, 'config', 'user.email', 'bob@example.com');
    await git(member, 'config', 'user.name', 'Bob');
    await writeFile(join(member, file), 'pushed straight to main\n');
    await git(member, 'add', '.');
    await git(member, 'commit', '-q', '-m', 'direct push');
    await git(member, 'push', '-q', 'origin', 'main');
    return git(member, 'rev-parse', 'HEAD');
  }

  // INVARIANT: a commit someone pushed to the install's `main` directly is
  // brought into local `main` (fast-forward) BEFORE the accept merges, so the
  // accepted work and the direct push both end up on the install's `main`.
  test('a hosted main that is ahead is fast-forwarded before the merge', async () => {
    const taskId = await finishedTaskWithCommit('Hosted ahead accept');
    const direct = await pushDirectlyToHostedMain('direct.txt');
    const accept = await withPresentedToken(ctx, alice, () => ctx.lazy(['accept', taskId, '--yes']));
    if (accept.exitCode !== 0) throw new Error(accept.stderr + accept.stdout);
    expect(await taskStatus(taskId)).toBe('complete');
    const originMain = (await runGit(['rev-parse', 'main'], { cwd: hosted })).stdout.trim();
    expect(originMain).toBe(await git(ctx.root, 'rev-parse', 'main'));
    expect((await runGit(['merge-base', '--is-ancestor', direct, originMain], { cwd: hosted })).exitCode).toBe(0);
    const tree = (await git(hosted, 'ls-tree', '--name-only', 'main')).split('\n');
    expect(tree).toContain('accepted.txt');
    expect(tree).toContain('direct.txt');
  }, 120_000);

  // INVARIANT: if the install's `main` and local `main` have DIVERGED, the
  // accept is refused before merging anything: never merged or overwritten
  // silently — local and hosted `main` stay exactly as they were.
  test('a diverged hosted main refuses the accept before merging', async () => {
    const taskId = await finishedTaskWithCommit('Hosted diverged accept');
    const direct = await pushDirectlyToHostedMain('direct.txt');
    // A local-only commit on main makes the two diverge.
    await writeFile(join(ctx.root, 'local-only.txt'), 'local\n');
    await git(ctx.root, 'add', 'local-only.txt');
    await git(ctx.root, 'commit', '-q', '-m', 'local only');
    const localBefore = await git(ctx.root, 'rev-parse', 'main');
    const statusBefore = await taskStatus(taskId);

    const accept = await withPresentedToken(ctx, alice, () => ctx.lazy(['accept', taskId, '--yes']));
    expect(accept.exitCode).not.toBe(0);
    expect(accept.stdout + accept.stderr).toContain('diverged');
    expect(await taskStatus(taskId)).toBe(statusBefore);
    expect(await git(ctx.root, 'rev-parse', 'main')).toBe(localBefore);
    expect((await runGit(['rev-parse', 'main'], { cwd: hosted })).stdout.trim()).toBe(direct);
  }, 180_000);
});
