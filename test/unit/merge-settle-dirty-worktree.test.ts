/**
 * Settling a conflicted worktree that `git merge --abort` refuses to touch.
 *
 * This is the second half of the live incident behind fix-merge-agent-nonclaude:
 * once merge_and_fix failed to launch, the recovery path could not clean up
 * either, because git refuses to abort a merge while a tracked file it touches
 * is stale or dirty in the index:
 *
 *     error: Entry 'bun.lock' not uptodate. Cannot merge.
 *     fatal: Could not reset index file to revision 'HEAD'.
 *
 * A post-turn check that runs `bun install` produces exactly that state, so the
 * task was left wedged mid-merge with no way out but a human at a terminal.
 *
 * The fixture reproduces the failure with real git before asserting the fix:
 * every test here first proves `git merge --abort` really is refused.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { settleConflictedWorktree, abortMergeIfInProgress } from '../../src/supervisor/merge';
import { readWorktreeMergeState, isMidMerge } from '../../src/git/operations';
import { resetElevatedGitChannel } from '../../src/supervisor/elevated-git';

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}

/**
 * A repo mid-merge with `file.txt` conflicted and `lock.txt` taken cleanly from
 * main — `lock.txt` stands in for the real `bun.lock`, a tracked file the merge
 * updates and a post-turn check then rewrites.
 */
async function createMidMergeRepo(dir: string): Promise<void> {
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@lazy.test');
  git(dir, 'config', 'user.name', 'Lazy Test');
  git(dir, 'checkout', '-b', 'main');
  await writeFile(join(dir, 'file.txt'), 'base\n');
  await writeFile(join(dir, 'lock.txt'), 'lock v1\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'Initial commit');

  await writeFile(join(dir, 'file.txt'), 'main content\n');
  await writeFile(join(dir, 'lock.txt'), 'lock v2\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'Change both on main');

  git(dir, 'checkout', '-b', 'feature', 'HEAD~1');
  await writeFile(join(dir, 'file.txt'), 'feature content\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'Change file on feature');

  // Conflicts on file.txt, updates lock.txt in place.
  git(dir, 'merge', 'main');
}

describe('settleConflictedWorktree with a dirty tracked file', () => {
  let root = '';

  afterEach(async () => {
    resetElevatedGitChannel();
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
  });

  async function setup(name = 'repo'): Promise<string> {
    if (!root) root = await mkdtemp(join(tmpdir(), 'lazy-merge-settle-'));
    const repo = join(root, name);
    await mkdir(repo, { recursive: true });
    await createMidMergeRepo(repo);
    expect(isMidMerge(await readWorktreeMergeState(repo))).toBe(true);
    return repo;
  }

  /**
   * Rewrite a file with its own bytes so only its stat data changes — the state
   * `bun install` leaves behind, and the one git reports as "not uptodate".
   *
   * The sleep is load-bearing: git treats an index entry as fresh when the size
   * and mtime match, and mtime granularity is coarse enough that an immediate
   * rewrite is indistinguishable from no write at all.
   */
  async function makeStatStale(path: string): Promise<void> {
    const content = await readFile(path, 'utf-8');
    await new Promise(resolve => setTimeout(resolve, 1100));
    await writeFile(path, content);
  }

  // INVARIANT (fix-merge-agent-nonclaude): a merely stat-stale tracked file —
  // same bytes, new mtime, which is what a post-turn `bun install` leaves
  // behind — is settled LOSSLESSLY. Nothing is discarded and no recovery patch
  // is written; the destructive rung is reserved for state that really would be
  // lost.
  //
  // Which rung does it is deliberately NOT asserted, because settle's own state
  // read (`git diff --diff-filter=U`) already re-stats and rewrites the index,
  // so the explicit `update-index --refresh` rung usually finds nothing left to
  // do. That rung stays as the belt to this suspenders: when the index cannot
  // be rewritten during the read (it is locked, or the read failed), staleness
  // survives into the abort and only the explicit refresh clears it — which is
  // exactly what the abortMergeIfInProgress case below exercises.
  test('settles a stat-stale "not uptodate" worktree without discarding anything', async () => {
    // Prove the failure first, in its own repo: plain `git merge --abort`
    // really is refused. A separate repo because a refused abort re-stats the
    // entries on its way out, which would clear the staleness under test.
    const proof = await setup('proof');
    await makeStatStale(join(proof, 'lock.txt'));
    const refused = git(proof, 'merge', '--abort');
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain('not uptodate');
    expect(isMidMerge(await readWorktreeMergeState(proof))).toBe(true);

    const repo = await setup();
    await makeStatStale(join(repo, 'lock.txt'));

    const result = await settleConflictedWorktree(repo);

    expect(result.settled).toBe(true);
    expect(isMidMerge(await readWorktreeMergeState(repo))).toBe(false);
    // The detail describes the actual outcome, so the human reading the sync
    // error knows what happened to their files.
    expect(result.detail).toMatch(/aborted the in-progress merge/i);
    // Nothing was destroyed and nothing was left in recovery: settling a
    // stat-stale worktree must not write a patch or reset.
    await expect(readdir(join(repo, '.lazy', 'recovery'))).rejects.toThrow();
  }, 30_000);

  // INVARIANT (fix-merge-agent-nonclaude): the DESTRUCTIVE rung never destroys
  // anything unrecoverably. When the file is genuinely modified, refreshing the
  // index cannot help, so settle saves the worktree diff to `.lazy/recovery/`
  // BEFORE resetting — and names the patch path in the detail it returns.
  test('saves a recovery patch before resetting when the file is really modified', async () => {
    const repo = await setup();
    await writeFile(join(repo, 'lock.txt'), 'edited by the agent after the merge\n');

    // Prove the failure first, including that the lossless rung cannot fix it.
    git(repo, 'update-index', '-q', '--refresh');
    const refused = git(repo, 'merge', '--abort');
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain('not uptodate');

    const result = await settleConflictedWorktree(repo);

    expect(result.settled).toBe(true);
    expect(isMidMerge(await readWorktreeMergeState(repo))).toBe(false);

    const patches = await readdir(join(repo, '.lazy', 'recovery'));
    expect(patches.length).toBe(1);
    expect(patches[0]).toMatch(/^merge-settle-.*\.patch$/);
    // The path is in the message, because a patch the human cannot find is the
    // same as no patch (CLAUDE.md: never silently discard).
    expect(result.detail).toContain(patches[0]!);
    // And the patch actually carries the discarded edit.
    const patch = await readFile(join(repo, '.lazy', 'recovery', patches[0]!), 'utf-8');
    expect(patch).toContain('edited by the agent after the merge');
  }, 30_000);

  // INVARIANT (fix-merge-agent-nonclaude): the destructive rung may only
  // destroy what it PROVABLY saved or PROVABLY confirmed empty. If the save
  // fails, settle does not reset — it reports settled: false and leaves the
  // worktree for a human. Resetting here would destroy real work while the
  // message claimed there was none to save, which is worse than the wedge.
  test('refuses to reset when the recovery patch could not be saved', async () => {
    const repo = await setup();
    await writeFile(join(repo, 'lock.txt'), 'work that must not vanish\n');

    // Prove the abort is refused, so the ladder really does reach rung 3.
    const refused = git(repo, 'merge', '--abort');
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain('not uptodate');

    // Break the save the way the filesystem can: `.lazy/recovery` exists, but
    // as a FILE, so the mkdir the save needs fails. Nothing about git is
    // touched, so the reset would otherwise have succeeded — which is the
    // point: the refusal is a decision, not a second failure.
    await mkdir(join(repo, '.lazy'), { recursive: true });
    await writeFile(join(repo, '.lazy', 'recovery'), 'not a directory\n');

    const result = await settleConflictedWorktree(repo);

    expect(result.settled).toBe(false);
    // The work is still there, untouched.
    expect(await readFile(join(repo, 'lock.txt'), 'utf-8')).toBe('work that must not vanish\n');
    expect(isMidMerge(await readWorktreeMergeState(repo))).toBe(true);
    // And the human is told WHY nothing was discarded, plus what to run.
    expect(result.detail).toMatch(/could not be captured/i);
    expect(result.detail).toContain('git merge --abort');
    expect(result.detail).toContain(repo);
  }, 30_000);

  // INVARIANT (fix-merge-agent-nonclaude): abortMergeIfInProgress gets the
  // lossless rung too — it runs mid-retry, between resolution attempts, so a
  // stat-stale file must not strand the retry loop. It deliberately does NOT
  // get the destructive rung: a retry that is about to run again must never
  // throw the agent's in-flight work away.
  test('abortMergeIfInProgress retries after a refresh but never resets', async () => {
    const stale = await setup('stale');
    await makeStatStale(join(stale, 'lock.txt'));

    expect(await abortMergeIfInProgress(stale)).toBe(true);
    expect(isMidMerge(await readWorktreeMergeState(stale))).toBe(false);

    // A genuinely modified file is NOT force-cleared here: the abort fails and
    // says so, leaving the decision to settle.
    const dirty = await setup('dirty');
    const dirtyLock = join(dirty, 'lock.txt');
    await writeFile(dirtyLock, 'still being worked on\n');
    expect(await abortMergeIfInProgress(dirty)).toBe(false);
    expect(await readFile(dirtyLock, 'utf-8')).toBe('still being worked on\n');
    expect(isMidMerge(await readWorktreeMergeState(dirty))).toBe(true);
  }, 30_000);
});
