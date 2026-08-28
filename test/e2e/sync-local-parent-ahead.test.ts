/**
 * E2E coverage for the fix-sync-stale-origin-parent incident.
 *
 * With a hosted driver, `lazy sync` resolved its merge target through
 * `driver.resolveUpstreamRef`, which always returns `origin/<parent>`. But
 * `lazy accept` merges an UNPROTECTED target — every intermediate `lazy/...`
 * task branch — into the LOCAL branch, and a parent task's own agent commits
 * can never be on origin (task agents have no push credentials).
 *
 * The observed symptom: accept refused with "Session branch has conflicts …
 * run lazy sync to resolve" while `lazy sync` answered "Already up to date."
 * Both were reading different refs, and the advice was unactionable from inside
 * the task.
 *
 * These tests drive a REAL bare git remote (same shape as
 * sync-live-upstream.test.ts) so the local/origin split is genuine rather than
 * mocked, and assert both halves of the fix: sync sees the local-only parent
 * commits, and it says out loud that the two refs differ.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, extractTaskId } from '../helpers/assertions';
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

describe('lazy sync <task> — parent ahead of origin', () => {
  let ctx: TestContext;
  const tmpDirs: string[] = [];

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
    await Promise.all(tmpDirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
  });

  /**
   * Point ctx.root at a fresh bare remote named `origin` and select the github
   * driver — its resolveUpstreamRef is a plain `git fetch origin <branch>`, so
   * no gh CLI is needed, and task branches really are published to the remote.
   */
  async function setupGithubRemote(): Promise<string> {
    const bareRemote = await mkdtemp(join(tmpdir(), 'lazy-e2e-origin-'));
    tmpDirs.push(bareRemote);
    gitIn(bareRemote, 'init', '--bare', '--initial-branch=main');

    // Commit the driver config BEFORE branching: task worktrees are checked out
    // from this tree, and syncTask loads config with cwd = worktreePath.
    // Edit the key rather than overwriting the file — a stub would throw away
    // the `external_path` init wrote, and the storage helpers below read it.
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
   * The parent's OWN agent commits between accepts: a commit on the parent task
   * branch that is local-only by construction (agents cannot push).
   */
  async function commitInWorktree(worktree: string, filename: string): Promise<string> {
    await writeFile(join(worktree, filename), 'work the parent agent did after the child branched\n');
    expect(gitIn(worktree, 'add', filename).exitCode).toBe(0);
    expect(gitIn(worktree, 'commit', '-m', `Parent agent commit (${filename})`).exitCode).toBe(0);
    return gitIn(worktree, 'rev-parse', 'HEAD').stdout.trim();
  }

  /**
   * INVARIANT: sync merges from the ref `lazy accept` will actually merge into.
   * A `lazy/...` parent is unprotected, so accept merges into the LOCAL branch —
   * and the parent's agent commits are never on origin. Resolving to
   * `origin/<parent>` here is what produced "Already up to date" alongside an
   * accept that refused with conflicts.
   */
  test('sees local-only parent commits instead of reporting "up to date"', async () => {
    await setupGithubRemote();

    const parentId = await createTask(ctx, 'Parent task', 'Parent work');
    await startAndSettle(parentId);

    const childCreate = await ctx.lazy([
      'create', '--goal', 'Child task', '--prompt', 'Child work', '--parent', parentId,
    ]);
    expectSuccess(childCreate);
    const childId = extractTaskId(childCreate.stdout);
    await startAndSettle(childId);

    const parentBranch = readSessionJson(ctx.root, parentId)?.git_branch as string;
    expect(parentBranch).toStartWith('lazy/');

    // The parent branch advances locally, exactly as its own agent would.
    const localOnlySha = await commitInWorktree(
      worktreePathFor(ctx.root, parentId), 'parent-local-only.txt',
    );

    // origin/<parent> is genuinely behind: nothing pushed that commit.
    expect(ctx.git('rev-parse', `origin/${parentBranch}`).stdout.trim()).not.toBe(localOnlySha);

    const result = await ctx.lazy(['sync', childId]);
    const output = result.stdout + result.stderr;

    // The load-bearing assertion: sync must NOT short-circuit against origin.
    expect(output.includes('Already up to date')).toBe(false);
    // And it must name both refs so the divergence is visible, not inferred.
    expect(output).toContain(parentBranch);
    expect(output).toContain(`origin/${parentBranch}`);
  }, 60_000);

  /**
   * The warning is half the fix: a human who sees "local and origin differ" can
   * act, where a silent choice of ref just moves the confusion. NEVER auto-push
   * the parent — the engineer may be mid-manual-work on it.
   */
  test('warns that local and origin parent diverge, and does not push the parent', async () => {
    await setupGithubRemote();

    const parentId = await createTask(ctx, 'Parent task', 'Parent work');
    await startAndSettle(parentId);

    const childCreate = await ctx.lazy([
      'create', '--goal', 'Child task', '--prompt', 'Child work', '--parent', parentId,
    ]);
    expectSuccess(childCreate);
    const childId = extractTaskId(childCreate.stdout);
    await startAndSettle(childId);

    const parentBranch = readSessionJson(ctx.root, parentId)?.git_branch as string;
    const originParentBefore = ctx.git('rev-parse', `origin/${parentBranch}`).stdout.trim();
    await commitInWorktree(worktreePathFor(ctx.root, parentId), 'parent-local-only.txt');

    const result = await ctx.lazy(['sync', childId]);
    const output = result.stdout + result.stderr;

    expect(output).toContain('only local');
    expect(output).toContain(`Used \`${parentBranch}\``);

    // INVARIANT: sync never pushes a parent branch. origin must be untouched.
    expect(ctx.git('rev-parse', `origin/${parentBranch}`).stdout.trim()).toBe(originParentBefore);
  }, 60_000);
});
