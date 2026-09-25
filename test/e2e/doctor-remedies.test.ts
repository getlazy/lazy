/**
 * The `lazy doctor --<remedy>` flags.
 *
 * INVARIANT: a remedy that is a lazy operation is a flag the human chooses, not
 * a command list to copy and not something doctor does on its own. Each flag has
 * the same four-step shape and every case below asserts one step of it:
 * list what it would touch → `--dry-run` stops there → a confirmation gates the
 * act (`--yes` skips it, and non-interactively its ABSENCE is a refusal, never
 * an implicit yes) → one line per item.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, expectOutputExcludes } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { setTaskStatus, worktreePathFor, readSessionJson, writeSessionJson } from '../helpers/storage';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A terminal task with a worktree still on disk — the shape `--clean-worktrees`
 * exists for. The tree is created directly rather than by starting the task:
 * what the remedy keys off is a directory at the task's worktree path, and a
 * plain directory also exercises the fallback teardown path (git does not know
 * this tree, so `git worktree remove` fails and `cleanupWorktree` falls back).
 */
async function seedTerminalWorktree(
  ctx: TestContext,
  goal: string,
  status: string,
): Promise<{ taskId: string; path: string }> {
  const taskId = await createTask(ctx, goal);
  setTaskStatus(ctx.root, taskId, status);
  const path = worktreePathFor(ctx.root, taskId);
  await mkdir(join(path, 'node_modules'), { recursive: true });
  await writeFile(join(path, 'node_modules', 'big.bin'), 'x'.repeat(4096));
  return { taskId, path };
}

describe('lazy doctor --clean-worktrees', () => {
  let ctx: TestContext;

  beforeEach(async () => { ctx = await setupTestLazy(); });
  afterEach(async () => { await ctx.cleanup(); });

  test('says so plainly when there is nothing to clean up', async () => {
    const result = await ctx.lazy(['doctor', '--clean-worktrees']);
    expectSuccess(result);
    expectOutput(result, 'No worktrees for finished tasks');
  });

  test('lists the worktrees of finished tasks with their size', async () => {
    const complete = await seedTerminalWorktree(ctx, 'Finished work', 'complete');
    const abandoned = await seedTerminalWorktree(ctx, 'Dropped work', 'abandoned');

    const result = await ctx.lazy(['doctor', '--clean-worktrees', '--dry-run']);
    expectSuccess(result);
    expectOutput(result, complete.path);
    expectOutput(result, abandoned.path);
    expectOutput(result, '2 worktree(s)');
    // Branches are a recovery path — the remedy must say it leaves them alone.
    expectOutput(result, 'Branches are kept');
    expectOutput(result, 'Dry run — nothing removed');

    // A dry run is a listing and nothing else.
    expect(await exists(complete.path)).toBe(true);
    expect(await exists(abandoned.path)).toBe(true);
  });

  test('leaves the worktree of a task that is still live alone', async () => {
    const live = await seedTerminalWorktree(ctx, 'Still going', 'blocked');

    const result = await ctx.lazy(['doctor', '--clean-worktrees', '--dry-run']);
    expectSuccess(result);
    expectOutput(result, 'No worktrees for finished tasks');
    expectOutputExcludes(result, live.path);
  });

  test('refuses to act non-interactively without --yes', async () => {
    const seeded = await seedTerminalWorktree(ctx, 'Finished work', 'complete');

    const result = await ctx.lazy(['doctor', '--clean-worktrees']);
    expectSuccess(result);
    expectOutput(result, 'Re-run with');
    expectOutput(result, '--yes');
    expectOutput(result, 'Aborted — nothing was removed.');
    expect(await exists(seeded.path)).toBe(true);
  });

  test('removes the worktrees with --yes, one line per tree', async () => {
    const seeded = await seedTerminalWorktree(ctx, 'Finished work', 'complete');

    const result = await ctx.lazy(['doctor', '--clean-worktrees', '--yes']);
    expectSuccess(result);
    expectOutput(result, `Removed ${seeded.path}`);
    expectOutput(result, 'Removed 1 of 1 worktree(s).');
    expect(await exists(seeded.path)).toBe(false);
  });
});

/**
 * The two remedies that need the container runtime, driven against the fake
 * `docker` on PATH rather than whatever the host happens to have — the point of
 * these cases is a runtime that answers in a specific way, which an ambient
 * docker cannot be asked to do.
 */
describe('lazy doctor: the runtime-dependent remedies', () => {
  let ctx: TestContext;
  let docker: FakeDocker;
  let scratch: string;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    scratch = await mkdtemp(join(tmpdir(), 'lazy-doctor-remedies-'));
    docker = await installFakeDocker(scratch);
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(scratch, { recursive: true, force: true });
  });

  /** Run `lazy doctor …` with the fake runtime ahead of any real one on PATH. */
  function doctor(args: string[]) {
    return ctx.lazy(['doctor', ...args], {
      env: { PATH: `${docker.binDir}:${process.env.PATH ?? ''}` },
    });
  }

  test('--clean-docker-images refuses when the runtime does not answer', async () => {
    // Installed, daemon not running — the state `which` cannot see.
    await docker.failInfo();

    const result = await doctor(['--clean-docker-images']);
    // INVARIANT: a listing that could not run must never read as "nothing to
    // clean up". `listLazyImages` returns [] when `docker images` exits
    // non-zero, so without the probe this printed a clean bill of health on no
    // evidence at all.
    expectFailure(result);
    expectError(result, 'Cannot reach docker');
    expectError(result, 'Nothing was inspected and nothing was removed');
  });

  test('--clean-docker-images says so plainly when the runtime answers and has nothing stale', async () => {
    const result = await doctor(['--clean-docker-images']);
    expectSuccess(result);
    expectOutput(result, 'No stale lazy images');
  });

  test('--clean-orphaned-containers refuses when the runtime does not answer', async () => {
    await docker.failInfo();

    const result = await doctor(['--clean-orphaned-containers']);
    expectFailure(result);
    expectError(result, 'Cannot reach docker');
    expectError(result, 'Nothing was inspected and nothing was removed');
  });

  test('--clean-orphaned-containers lists a stopped container for one of our tasks', async () => {
    const taskId = await createTask(ctx, 'Finished work');
    setTaskStatus(ctx.root, taskId, 'complete');
    await docker.seedContainer(`lazy-${taskId}`);

    const result = await doctor(['--clean-orphaned-containers', '--dry-run']);
    expectSuccess(result);
    expectOutput(result, `lazy-${taskId}`);
    expectOutput(result, 'Dry run — nothing removed');
    // A dry run is a listing and nothing else.
    expect(await docker.containers()).toContain(`lazy-${taskId}`);
  });

  test('--clean-orphaned-containers refuses to act non-interactively without --yes', async () => {
    const taskId = await createTask(ctx, 'Finished work');
    setTaskStatus(ctx.root, taskId, 'complete');
    await docker.seedContainer(`lazy-${taskId}`);

    const result = await doctor(['--clean-orphaned-containers']);
    expectSuccess(result);
    expectOutput(result, 'Aborted — nothing was removed.');
    expect(await docker.containers()).toContain(`lazy-${taskId}`);
  });

  test('--clean-orphaned-containers removes with --yes, one line per container', async () => {
    const taskId = await createTask(ctx, 'Finished work');
    setTaskStatus(ctx.root, taskId, 'complete');
    await docker.seedContainer(`lazy-${taskId}`);

    const result = await doctor(['--clean-orphaned-containers', '--yes']);
    expectSuccess(result);
    expectOutput(result, `Removed lazy-${taskId}`);
    expectOutput(result, 'Removed 1 of 1 container(s).');
    expect(await docker.containers()).not.toContain(`lazy-${taskId}`);
  });

  test('--clean-orphaned-containers reports a removal the runtime refused', async () => {
    const taskId = await createTask(ctx, 'Finished work');
    setTaskStatus(ctx.root, taskId, 'complete');
    await docker.seedContainer(`lazy-${taskId}`);
    await docker.failRemovals();

    const result = await doctor(['--clean-orphaned-containers', '--yes']);
    // INVARIANT: a batch in which anything failed exits non-zero. The per-item
    // failure is printed and the loop continues, so the exit code is the only
    // signal a script or `&&` chain can read.
    expectFailure(result);
    // INVARIANT: `removeRun` reports failure by LOGGING it — `removeContainer`
    // warns on a non-zero `rm` and returns normally — so a clean return is not
    // evidence the container is gone. The remedy asks the runtime again, and a
    // container still present is a failure line, never `Removed …`.
    expectOutput(result, `Failed to remove lazy-${taskId}`);
    expectOutput(result, 'still present afterwards');
    expectOutput(result, 'Removed 0 of 1 container(s).');
    expect(await docker.containers()).toContain(`lazy-${taskId}`);
  });
});

describe('lazy doctor --unset-upstream-tracking', () => {
  let ctx: TestContext;

  beforeEach(async () => { ctx = await setupTestLazy(); });
  afterEach(async () => { await ctx.cleanup(); });

  async function seedTrackedBranch(branch: string, merge: string): Promise<void> {
    await ctx.git('branch', branch);
    await ctx.git('config', `branch.${branch}.remote`, 'origin');
    await ctx.git('config', `branch.${branch}.merge`, merge);
  }

  test('says so plainly when no task branch has tracking', async () => {
    await ctx.git('branch', 'lazy/untracked-task');

    const result = await ctx.lazy(['doctor', '--unset-upstream-tracking']);
    expectSuccess(result);
    expectOutput(result, 'No task branches have upstream tracking');
  });

  test('lists tracked task branches and flags only a mismatched merge ref', async () => {
    await seedTrackedBranch('lazy/self-tracking', 'refs/heads/lazy/self-tracking');
    await seedTrackedBranch('lazy/points-elsewhere', 'refs/heads/main');

    const result = await ctx.lazy(['doctor', '--unset-upstream-tracking', '--dry-run']);
    expectSuccess(result);
    expectOutput(result, 'lazy/self-tracking → origin refs/heads/lazy/self-tracking');
    // INVARIANT: tracking a branch to its OWN remote counterpart is ordinary git
    // config — `git pull` consults only the current branch's upstream, so it
    // cannot make a task branch flow into main. Only a merge ref naming a
    // DIFFERENT branch is hazardous, and only that one is escalated.
    expectOutput(result, 'lazy/points-elsewhere → origin refs/heads/main');
    expectOutput(result, 'merges a DIFFERENT branch');
    expectOutput(result, 'Dry run — nothing unset');

    const still = await ctx.git('config', 'branch.lazy/self-tracking.remote');
    expect(still.stdout.trim()).toBe('origin');
  });

  test('unsets only the config entries, leaving the branches in place', async () => {
    await seedTrackedBranch('lazy/self-tracking', 'refs/heads/lazy/self-tracking');

    const result = await ctx.lazy(['doctor', '--unset-upstream-tracking', '--yes']);
    expectSuccess(result);
    expectOutput(result, 'Unset tracking on lazy/self-tracking');
    expectOutput(result, 'Unset tracking on 1 of 1 branch(es).');

    const remote = await ctx.git('config', 'branch.lazy/self-tracking.remote');
    expect(remote.stdout.trim()).toBe('');
    const branches = await ctx.git('branch', '--format=%(refname:short)');
    expect(branches.stdout).toContain('lazy/self-tracking');
  });

  test('refuses to act non-interactively without --yes', async () => {
    await seedTrackedBranch('lazy/self-tracking', 'refs/heads/lazy/self-tracking');

    const result = await ctx.lazy(['doctor', '--unset-upstream-tracking']);
    expectSuccess(result);
    expectOutput(result, 'Aborted — nothing was unset.');
    const remote = await ctx.git('config', 'branch.lazy/self-tracking.remote');
    expect(remote.stdout.trim()).toBe('origin');
  });

  test('reports a key it could not unset instead of claiming success', async () => {
    // The tracking config lives in the user's GLOBAL file. `git config --unset`
    // only ever writes the LOCAL one, so it exits 5 and the key stays fully
    // readable — the case a bare "did the unset command run?" check reports as
    // done. Driven through GIT_CONFIG_GLOBAL so the subprocess's git really
    // resolves it from a file the remedy cannot write.
    await ctx.git('branch', 'lazy/from-global');
    const globalConfig = join(ctx.root, 'fake-global-gitconfig');
    await writeFile(
      globalConfig,
      '[branch "lazy/from-global"]\n\tremote = origin\n\tmerge = refs/heads/lazy/from-global\n',
    );

    const result = await ctx.lazy(['doctor', '--unset-upstream-tracking', '--yes'], {
      env: { GIT_CONFIG_GLOBAL: globalConfig },
    });
    // INVARIANT: the remedy READS THE KEY BACK and reports what is still there,
    // naming the file that holds it. Nothing was unset, so this is a failure —
    // `Unset tracking on 1 of 1` here would be a false success on the one
    // operation the human asked for.
    expectFailure(result);
    expectOutput(result, 'Failed to unset lazy/from-global');
    expectOutput(result, 'is still set in');
    expectOutput(result, globalConfig);
    expectOutput(result, 'Unset tracking on 0 of 1 branch(es).');
  });
});

describe('lazy doctor --resume-interrupted-tasks', () => {
  let ctx: TestContext;

  beforeEach(async () => { ctx = await setupTestLazy(); });
  afterEach(async () => { await ctx.cleanup(); });

  test('says so plainly when nothing is interrupted', async () => {
    const result = await ctx.lazy(['doctor', '--resume-interrupted-tasks']);
    expectSuccess(result);
    expectOutput(result, 'No interrupted tasks');
  });

  test('lists interrupted tasks and says exactly what the daemon promises', async () => {
    const taskId = await createTask(ctx, 'Interrupted work');
    setTaskStatus(ctx.root, taskId, 'interrupted');

    const result = await ctx.lazy(['doctor', '--resume-interrupted-tasks', '--dry-run']);
    expectSuccess(result);
    expectOutput(result, '1 interrupted task(s):');
    // INVARIANT: the reconciler RE-OFFERS the resume, it does not promise one.
    // `maybeAutoResume` gates on `user_stopped`, MAX_CONSECUTIVE_INTERRUPTIONS
    // and the auto-react budget — so "a running daemon resumes these on its own"
    // is false for precisely the tasks this flag exists to start.
    expectOutput(result, 're-offers these each tick');
    expectOutput(result, 'can veto it');
    expectOutput(result, 'Dry run — nothing resumed');
  });

  test('refuses to act non-interactively without --yes', async () => {
    const taskId = await createTask(ctx, 'Interrupted work');
    setTaskStatus(ctx.root, taskId, 'interrupted');

    const result = await ctx.lazy(['doctor', '--resume-interrupted-tasks']);
    expectSuccess(result);
    expectOutput(result, 'Aborted — nothing was resumed.');
  });
});

describe('lazy doctor: remedy dispatch', () => {
  let ctx: TestContext;

  beforeEach(async () => { ctx = await setupTestLazy(); });
  afterEach(async () => { await ctx.cleanup(); });

  test('refuses more than one remedy in a single run', async () => {
    const result = await ctx.lazy(['doctor', '--clean-worktrees', '--unset-upstream-tracking']);
    expectFailure(result);
    expectError(result, 'Run one remedy at a time');
    expectError(result, '--clean-worktrees');
    expectError(result, '--unset-upstream-tracking');
  });

  test('a remedy runs instead of the health sweep, not alongside it', async () => {
    const result = await ctx.lazy(['doctor', '--clean-worktrees']);
    expectSuccess(result);
    // The sweep's own headings must not appear: a remedy is a separate mode.
    expectOutputExcludes(result, 'Checking environment');
  });

  test('every remedy flag is documented in the usage text', async () => {
    const result = await ctx.lazy(['doctor', '--help']);
    expectSuccess(result);
    for (const flag of [
      '--clean-worktrees',
      '--clean-docker-images',
      '--clean-orphaned-containers',
      '--unset-upstream-tracking',
      '--resume-interrupted-tasks',
    ]) {
      expectOutput(result, flag);
    }
    expectOutput(result, 'only REPORTS');
  });

  test('doctor never resumes interrupted tasks on its own', async () => {
    const taskId = await createTask(ctx, 'Interrupted work', 'Do the work');
    const started = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(started);
    await ctx.lazyMocked(['list'], MOCK_CLAUDE_SUCCESS);

    const containerName = `lazy-${taskId}`;
    setTaskStatus(ctx.root, taskId, 'interrupted');
    const session = readSessionJson(ctx.root, taskId);
    if (!session) throw new Error(`Task ${taskId} has no session.json — was it started?`);
    session.container_name = containerName;
    writeSessionJson(ctx.root, taskId, session);

    const result = await ctx.lazyMocked(['doctor'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_CRASHED_CONTAINERS: containerName },
    });
    // INVARIANT: doctor reports, the human chooses. Doctor used to auto-resume
    // interrupted tasks by spawning `process.argv[0]`, which in a released
    // binary is an embedded `bun` that is not on PATH — so the hidden action
    // failed every time with "binary 'bun' not found".
    expectOutputExcludes(result, 'Resuming');
    expectOutput(result, 'Interrupted tasks (resumable):');
    expectOutput(result, 'lazy doctor --resume-interrupted-tasks');
    expect(result.stdout + result.stderr).not.toContain("binary 'bun' not found");
  });
});
