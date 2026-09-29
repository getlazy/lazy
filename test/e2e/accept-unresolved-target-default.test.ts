import { describe, test, expect, afterEach } from 'bun:test';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readTaskJson, writeTaskJson } from '../helpers/storage';
import { seedFinal } from '../helpers/final';

/**
 * A ROOT task with no named integration target (an unresolved '' branch slot)
 * integrates into the REMOTE'S DEFAULT branch — what sync, remote-sync and the
 * drivers resolve it to. Accept used to fall back to the literal `main`, which
 * in a `master`-default repo is a branch that does not exist.
 *
 * Every test here runs in a repo whose ONLY branch is `master` (local `main` is
 * renamed away), with a bare origin whose HEAD points at `master`.
 */
describe('lazy accept with no named target in a master-default repo', () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx.cleanup();
  });

  function useMasterDefault(): void {
    expect(ctx.git('branch', '-m', 'main', 'master').exitCode).toBe(0);
    const bare = join(ctx.root, '.test-remote.git');
    expect(ctx.git('init', '--bare', '-b', 'master', bare).exitCode).toBe(0);
    if (ctx.git('remote', 'get-url', 'origin').exitCode === 0) {
      expect(ctx.git('remote', 'set-url', 'origin', bare).exitCode).toBe(0);
    } else {
      expect(ctx.git('remote', 'add', 'origin', bare).exitCode).toBe(0);
    }
    expect(ctx.git('push', 'origin', 'master').exitCode).toBe(0);
    expect(ctx.git('remote', 'set-head', 'origin', 'master').exitCode).toBe(0);
    expect(ctx.git('rev-parse', '--verify', '--quiet', 'refs/heads/main').exitCode).not.toBe(0);
  }

  /** Start, wait, clear the target to the unresolved sentinel, add a commit. */
  async function readyTaskWithUnresolvedTarget(file: string): Promise<string> {
    const taskId = await createTask(ctx, 'Unresolved target', 'Add a file');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);
    await seedFinal(ctx, taskId);

    const task = readTaskJson(ctx.root, taskId);
    task.target = { kind: 'branch', branch: '' };
    writeTaskJson(ctx.root, taskId, task);

    const worktree = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktree, file), 'content\n');
    expect(ctx.git('-C', worktree, 'add', file).exitCode).toBe(0);
    expect(ctx.git('-C', worktree, 'commit', '-m', `Add ${file}`).exitCode).toBe(0);
    return taskId;
  }

  // INVARIANT: a local accept of a root task with no named target merges into
  // the remote's default branch, never a literal `main`.
  test('local accept merges into master', async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    useMasterDefault();
    const taskId = await readyTaskWithUnresolvedTarget('local.txt');

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(result);
    expectOutput(result, 'accepted and merged');
    expect(ctx.git('cat-file', '-e', 'master:local.txt').exitCode).toBe(0);
    expect(ctx.git('rev-parse', '--verify', '--quiet', 'refs/heads/main').exitCode).not.toBe(0);
  }, 60_000);

  // INVARIANT: a forge accept (protected target) of a root task with no named
  // target merges its PR into the remote's default branch.
  test('forge accept merges into master', async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: {
        LAZY_MOCK_ACCEPT_GATES: '[]',
        LAZY_MOCK_PROTECTED_BRANCH: '1',
        LAZY_MOCK_NEEDS_SYNC: '1',
      },
    });
    useMasterDefault();
    const tomlPath = join(ctx.root, 'lazy.toml');
    const toml = readFileSync(tomlPath, 'utf-8');
    const withApprove = toml.includes('[remote]\n')
      ? toml.replace('[remote]\n', '[remote]\nauto_approve = true\n')
      : `${toml}\n[remote]\nauto_approve = true\n`;
    expect(withApprove).not.toBe(toml);
    writeFileSync(tomlPath, withApprove);

    const taskId = await readyTaskWithUnresolvedTarget('forge.txt');

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(result);
    expectOutput(result, 'accepted and merged');

    const log = join(ctx.protocolBase, 'mock-merges.jsonl');
    expect(existsSync(log)).toBe(true);
    const targets = readFileSync(log, 'utf-8').trim().split('\n').map(l => JSON.parse(l).target);
    expect(targets).toEqual(['master']);
  }, 60_000);
});
