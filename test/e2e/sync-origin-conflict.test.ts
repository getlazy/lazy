/**
 * The conflicted half of sync's ORIGIN step, on the fake-`claude`-binary seam
 * (the REAL supervisor, a scriptable fake agent).
 *
 * WHY THIS SEAM: a conflict between a colleague's push and the task's own work
 * is resolved by INVOKING the task's agent, and the module mock replaces the
 * whole supervisor — it never runs one. Only here is the real merge, the real
 * agent launch, and the real resolution commit observable.
 *
 * INVARIANT: a colleague pushing to `origin/<task-branch>` is reconciled by
 * `lazy sync`, conflicts and all, without a human pairing into the worktree to
 * run `git merge` by hand. The parent step still runs after it, and neither step
 * touches the parent branch.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { successScenario } from '../helpers/fake-claude';
import { allTurns } from '../helpers/agent-seam';
import { readSessionJson, worktreePathFor } from '../helpers/storage';

function gitIn(cwd: string, ...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode };
}

describe('lazy sync <task> — conflict with a colleague push', () => {
  let ctx: TestContext;
  const tmpDirs: string[] = [];

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
    await Promise.all(tmpDirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
  });

  /** A bare `origin` plus the github driver, whose fetchBranch is plain git. */
  async function setupGithubRemote(): Promise<string> {
    const bareRemote = await mkdtemp(join(tmpdir(), 'lazy-e2e-origin-'));
    tmpDirs.push(bareRemote);
    gitIn(bareRemote, 'init', '--bare', '--initial-branch=main');

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

  test('the task agent resolves a conflict from origin, then the parent step runs', async () => {
    const bareRemote = await setupGithubRemote();

    const taskId = await createTask(ctx, 'Colleague conflict', 'Do the work');

    await ctx.setClaudeScenario(successScenario({
      result: 'First pass.',
      sessionId: 'fake-sess-origin-1',
      commit: { message: 'Shared file', files: [{ path: 'shared.txt', content: 'shared base\n' }] },
    }));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const branch = readSessionJson(ctx.root, taskId)?.git_branch as string;
    expect(branch).toStartWith('lazy/');
    const worktree = worktreePathFor(ctx.root, taskId);
    expect(gitIn(worktree, 'push', 'origin', branch).exitCode).toBe(0);

    // A colleague edits the SAME line on the task's branch and pushes.
    const clone = await mkdtemp(join(tmpdir(), 'lazy-e2e-colleague-'));
    tmpDirs.push(clone);
    expect(gitIn(clone, 'clone', bareRemote, '.').exitCode).toBe(0);
    gitIn(clone, 'config', 'user.email', 'colleague@lazy.test');
    gitIn(clone, 'config', 'user.name', 'Colleague');
    expect(gitIn(clone, 'checkout', branch).exitCode).toBe(0);
    await writeFile(join(clone, 'shared.txt'), 'colleague version\n');
    gitIn(clone, 'add', '.');
    gitIn(clone, 'commit', '-m', 'Colleague edit');
    expect(gitIn(clone, 'push', 'origin', branch).exitCode).toBe(0);
    const colleagueSha = gitIn(clone, 'rev-parse', 'HEAD').stdout.trim();

    // The task's side edits the same line locally, and that commit is NOT on
    // origin — the push that would carry it is refused while origin is ahead.
    // This is exactly the divergence the engineer hits: two heads, same line.
    await writeFile(join(worktree, 'shared.txt'), 'task version\n');
    expect(gitIn(worktree, 'add', 'shared.txt').exitCode).toBe(0);
    expect(gitIn(worktree, 'commit', '-m', 'Task edit').exitCode).toBe(0);

    // The parent moves too, so the second step has work to do as well.
    ctx.git('checkout', 'main');
    await writeFile(join(ctx.root, 'from-parent.txt'), 'landed on main\n');
    ctx.git('add', 'from-parent.txt');
    ctx.git('commit', '-m', 'Parent side');
    ctx.git('checkout', '-');

    await ctx.clearClaudeInvocations();
    await ctx.setClaudeScenario(successScenario({
      result: 'Kept both the colleague and task versions.',
      sessionId: 'fake-sess-origin-2',
      commit: { message: 'Resolve conflict', files: [{ path: 'shared.txt', content: 'merged version\n' }] },
    }));

    expectSuccess(await ctx.lazy(['sync', taskId]));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // The agent really was invoked to resolve — the merge was not silently
    // dropped, nor left conflicted in the worktree.
    expect((await ctx.claudeInvocations()).length).toBeGreaterThan(0);
    expect(await readFile(join(worktree, 'shared.txt'), 'utf-8')).toBe('merged version\n');
    expect(gitIn(worktree, 'merge-base', '--is-ancestor', colleagueSha, 'HEAD').exitCode).toBe(0);

    // The parent step still ran afterwards, on the reconciled branch.
    expect(await readFile(join(worktree, 'from-parent.txt'), 'utf-8')).toContain('landed on main');

    // Both steps are recorded on the task, origin first.
    const syncTurns = (await allTurns(ctx.root, taskId))
      .filter(t => t.turn_type === 'sync')
      .map(t => String(t.content ?? ''));
    const originTurn = syncTurns.findIndex(c => c.includes(`origin/${branch}`));
    const parentTurn = syncTurns.findIndex(c => c.includes('Merged main'));
    expect(originTurn).toBeGreaterThan(-1);
    expect(parentTurn).toBeGreaterThan(originTurn);
    expect(syncTurns[originTurn]).toContain('resolved conflict');
    // The agent's own resolution reply is recorded alongside the announcement.
    expect(syncTurns.some(c => c.includes('Kept both'))).toBe(true);
  }, 180_000);
});
