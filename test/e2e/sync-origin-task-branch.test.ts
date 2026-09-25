/**
 * E2E coverage for sync's ORIGIN step: reconciling a task's OWN branch with
 * `origin/<task-branch>` when a colleague has pushed to it.
 *
 * Before this, commits a colleague pushed to a task's branch were unreachable
 * from lazy — the only way in was `lazy pair` and a hand-run `git merge`. Sync
 * now runs two named steps: the task's own branch on origin first, then the
 * parent as before. Neither step ever touches or pushes the parent branch.
 *
 * These tests drive a REAL bare remote and a second clone acting as the
 * colleague, so "origin has moved" is genuine rather than mocked.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readSessionJson, worktreePathFor } from '../helpers/storage';

/** Run a git command in an arbitrary directory (outside ctx.root). */
function gitIn(cwd: string, ...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

describe('lazy sync <task> — task branch on origin', () => {
  let ctx: TestContext;
  const tmpDirs: string[] = [];

  beforeEach(async () => {
    // start/sync route through the daemon for storage and supervisor launch.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
    await Promise.all(tmpDirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
  });

  /**
   * Point ctx.root at a fresh bare remote named `origin` and select the github
   * driver — its fetchBranch is a plain `git fetch origin <branch>`, so no gh
   * CLI is needed and task branches really are published to the remote.
   */
  async function setupGithubRemote(): Promise<string> {
    const bareRemote = await mkdtemp(join(tmpdir(), 'lazy-e2e-origin-'));
    tmpDirs.push(bareRemote);
    gitIn(bareRemote, 'init', '--bare', '--initial-branch=main');

    // Edit the driver key rather than overwriting the file — a stub would throw
    // away the `external_path` init wrote, and the storage helpers read it.
    const tomlPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(tomlPath, 'utf-8');
    const after = before.replace('driver = "local"', 'driver = "github"');
    expect(after).not.toBe(before);
    await writeFile(tomlPath, after);
    expect(ctx.git('add', 'lazy.toml').exitCode).toBe(0);
    expect(ctx.git('commit', '-m', 'Use github driver').exitCode).toBe(0);

    expect(ctx.git('remote', 'add', 'origin', bareRemote).exitCode).toBe(0);
    expect(ctx.git('push', 'origin', 'main').exitCode).toBe(0);
    return bareRemote;
  }

  async function startAndSettle(taskId: string): Promise<void> {
    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);
  }

  /**
   * A colleague clones the remote, adds a commit on the task's branch, pushes.
   * `file`/`content` let a test choose between a clean addition and an edit that
   * collides with what the task's own worktree already changed.
   */
  async function colleaguePushesToTaskBranch(
    bareRemote: string, branch: string, file: string, content: string,
  ): Promise<string> {
    const clone = await mkdtemp(join(tmpdir(), 'lazy-e2e-colleague-'));
    tmpDirs.push(clone);
    expect(gitIn(clone, 'clone', bareRemote, '.').exitCode).toBe(0);
    gitIn(clone, 'config', 'user.email', 'colleague@lazy.test');
    gitIn(clone, 'config', 'user.name', 'Colleague');
    expect(gitIn(clone, 'checkout', branch).exitCode).toBe(0);
    await writeFile(join(clone, file), content);
    gitIn(clone, 'add', '.');
    gitIn(clone, 'commit', '-m', `Colleague commit on ${branch}`);
    expect(gitIn(clone, 'push', 'origin', branch).exitCode).toBe(0);
    return gitIn(clone, 'rev-parse', 'HEAD').stdout.trim();
  }

  /** Publish the task's branch so a colleague has something to push onto. */
  function publishTaskBranch(taskId: string): string {
    const branch = readSessionJson(ctx.root, taskId)?.git_branch as string;
    expect(branch).toStartWith('lazy/');
    const worktree = worktreePathFor(ctx.root, taskId);
    expect(gitIn(worktree, 'push', 'origin', branch).exitCode).toBe(0);
    return branch;
  }

  /**
   * INVARIANT: a colleague's commits on the task's OWN branch are merged into
   * the worktree by sync. This is the whole point of the origin step — before
   * it, the only route was `lazy pair` plus a hand-run merge.
   */
  test('merges commits a colleague pushed to the task branch', async () => {
    const bareRemote = await setupGithubRemote();

    const taskId = await createTask(ctx, 'Colleague pushed', 'Do work');
    await startAndSettle(taskId);
    const branch = publishTaskBranch(taskId);

    const colleagueSha = await colleaguePushesToTaskBranch(
      bareRemote, branch, 'colleague.txt', 'work a colleague pushed\n',
    );

    const worktree = worktreePathFor(ctx.root, taskId);
    const before = gitIn(worktree, 'rev-parse', 'HEAD').stdout.trim();
    expect(before).not.toBe(colleagueSha);

    const result = await ctx.lazy(['sync', taskId]);
    expectSuccess(result);
    const output = result.stdout + result.stderr;
    // The origin step is named as it happens, not silently folded into "sync".
    expect(output).toContain(`origin/${branch}`);
    expect(output.includes('Already up to date')).toBe(false);

    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    // The colleague's commit is now an ancestor of the task branch's HEAD, and
    // their file is in the worktree.
    expect(gitIn(worktree, 'merge-base', '--is-ancestor', colleagueSha, 'HEAD').exitCode).toBe(0);
    expect(await readFile(join(worktree, 'colleague.txt'), 'utf-8')).toContain('a colleague pushed');

    // The merge is recorded on the task, so the human can see where it came from.
    const show = await ctx.lazy(['show', taskId]);
    expect(show.stdout + show.stderr).toContain(`origin/${branch}`);
  }, 90_000);

  /**
   * INVARIANT: the origin step runs BEFORE the parent step, and the parent step
   * still runs afterwards. Reconciling the branch and then merging the parent is
   * the order accept will see; doing the parent first would merge into a branch
   * that is still missing the colleague's work.
   */
  test('runs the origin step first and still merges the parent afterwards', async () => {
    const bareRemote = await setupGithubRemote();

    const taskId = await createTask(ctx, 'Both steps', 'Do work');
    await startAndSettle(taskId);
    const branch = publishTaskBranch(taskId);

    await colleaguePushesToTaskBranch(bareRemote, branch, 'colleague.txt', 'colleague work\n');

    // The parent (main) moves too — out of band, on the remote.
    const parentClone = await mkdtemp(join(tmpdir(), 'lazy-e2e-parent-'));
    tmpDirs.push(parentClone);
    expect(gitIn(parentClone, 'clone', bareRemote, '.').exitCode).toBe(0);
    gitIn(parentClone, 'config', 'user.email', 'upstream@lazy.test');
    gitIn(parentClone, 'config', 'user.name', 'Upstream Dev');
    await writeFile(join(parentClone, 'upstream-only.txt'), 'landed on the parent\n');
    gitIn(parentClone, 'add', '.');
    gitIn(parentClone, 'commit', '-m', 'Parent commit');
    expect(gitIn(parentClone, 'push', 'origin', 'main').exitCode).toBe(0);

    const result = await ctx.lazy(['sync', taskId]);
    expectSuccess(result);
    const output = result.stdout + result.stderr;
    // Ordering is observable in the narration: the origin ref is announced
    // before the parent ref.
    expect(output.indexOf(`origin/${branch}`)).toBeGreaterThan(-1);
    expect(output.indexOf(`origin/${branch}`)).toBeLessThan(output.lastIndexOf('main'));

    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    const worktree = worktreePathFor(ctx.root, taskId);
    // BOTH merges landed: the colleague's file and the parent's file.
    expect(await readFile(join(worktree, 'colleague.txt'), 'utf-8')).toContain('colleague work');
    expect(await readFile(join(worktree, 'upstream-only.txt'), 'utf-8')).toContain('landed on the parent');
  }, 90_000);

  /**
   * INVARIANT: with the `local` driver there is no origin to reconcile against,
   * and sync says so in one line instead of failing or staying silent.
   */
  test('skips the origin step with a one-line notice when the driver is local', async () => {
    const taskId = await createTask(ctx, 'Local driver', 'Do work');
    await startAndSettle(taskId);

    const result = await ctx.lazy(['sync', taskId]);
    expectSuccess(result);
    const output = result.stdout + result.stderr;

    expect(output).toContain('Check task branch on origin');
    expect(output).toContain('local');
  }, 60_000);
});
