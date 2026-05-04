/**
 * Unit tests for the `recoverBacklogWithCommits` reconcile sweep.
 *
 * Background — the bug this sweep exists to fix:
 *
 *   When the supervisor's post-turn check exited non-zero, a previous
 *   migration (`migrateBlockedToBacklog`, removed) demoted the just-blocked
 *   task to `backlog`, leaving real committed work hidden behind a status
 *   that says "never started." Downstream commands gate on status, so the
 *   task became unrecoverable.
 *
 *   The fix has two parts: (1) the broken migration is gone, and (2) this
 *   sweep proactively recovers any backlog task whose branch already has
 *   commits — including the historical scenario above and the future
 *   "moved lazy-dev between machines" scenario where the session blob
 *   doesn't exist locally but the branch (with commits) does.
 *
 * INVARIANTS this file encodes:
 *
 *   1. Source of truth for "is there work?" is the git branch — sessions
 *      and worktrees are local on-disk state that doesn't travel between
 *      machines, but branches do. The sweep MUST key off branch commits,
 *      not the local session record.
 *
 *   2. A backlog task with no branch, or a branch with no commits beyond
 *      its base, MUST stay in backlog. Recovery is only for tasks where
 *      the branch demonstrates real work.
 *
 *   3. The recovery transition `backlog → blocked` MUST go through the
 *      canonical state machine in `src/task-state-machine.ts`. Ad-hoc
 *      module-local transition guards drift; the table doesn't.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { recoverBacklogWithCommits } from '../../src/utils/reconcile';
import { spawnSync } from '../../src/utils/spawn';

function git(cwd: string, ...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    stdout: result.stdout?.toString().trim() ?? '',
    stderr: result.stderr?.toString().trim() ?? '',
    exitCode: result.exitCode ?? -1,
  };
}

interface Env {
  lazyRoot: string;
  storage: FileStorage;
  baseSha: string;
  cleanup: () => Promise<void>;
}

async function setupEnv(): Promise<Env> {
  const lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-recover-root-'));
  const basePath = await mkdtemp(join(tmpdir(), 'lazy-recover-store-'));

  // Initialize a git repo in lazyRoot — the sweep shells out to git here.
  git(lazyRoot, 'init');
  git(lazyRoot, 'config', 'user.email', 'test@lazy.test');
  git(lazyRoot, 'config', 'user.name', 'Lazy Test');
  git(lazyRoot, 'checkout', '-b', 'main');
  await writeFile(join(lazyRoot, 'README.md'), '# base\n');
  git(lazyRoot, 'add', '.');
  git(lazyRoot, 'commit', '-m', 'base');
  const baseSha = git(lazyRoot, 'rev-parse', 'HEAD').stdout;

  const storage = new FileStorage(lazyRoot, { basePath });
  await storage.initialize();

  return {
    lazyRoot,
    storage,
    baseSha,
    cleanup: async () => {
      await storage.close();
      await Promise.all([
        rm(lazyRoot, { recursive: true, force: true }),
        rm(basePath, { recursive: true, force: true }),
      ]);
    },
  };
}

/**
 * Create a backlog task and return its short ID — the same value taskRef()
 * uses for branch naming when no task_ref metadata is set.
 */
async function makeBacklogTask(env: Env, goal: string): Promise<string> {
  const task = await env.storage.createTask(goal, undefined, env.baseSha);
  return task.id.substring(0, 8);
}

/** Create the conventional `lazy/<ref>` branch with N extra commits beyond base. */
function makeBranchWithCommits(env: Env, ref: string, count: number): void {
  git(env.lazyRoot, 'branch', `lazy/${ref}`, env.baseSha);
  if (count === 0) return;
  // Use a worktree so we don't disturb the lazyRoot HEAD that the sweep reads.
  const wt = join(env.lazyRoot, '..', `${ref}-wt`);
  git(env.lazyRoot, 'worktree', 'add', wt, `lazy/${ref}`);
  for (let i = 0; i < count; i++) {
    git(wt, 'commit', '--allow-empty', '-m', `agent commit ${i + 1}`);
  }
  git(env.lazyRoot, 'worktree', 'remove', wt, '--force');
}

describe('recoverBacklogWithCommits', () => {
  let env: Env;

  beforeEach(async () => {
    env = await setupEnv();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  // INVARIANT 1+2: branch with real work → recover to blocked.
  // This is the regression case for "stuck in backlog after non-zero check exit"
  // and also the durable case (no session needed, only the branch).
  test('recovers backlog task whose branch has commits beyond base', async () => {
    const ref = await makeBacklogTask(env, 'has work');
    makeBranchWithCommits(env, ref, 1);

    await recoverBacklogWithCommits(env.storage, env.lazyRoot);

    const task = await env.storage.getTask(ref);
    expect(task?.status).toBe('blocked');
  });

  // INVARIANT 1: machine-move scenario — session blob is absent locally but
  // the branch (with commits) survived the machine move. Recovery must still
  // fire because branches, not sessions, are the durable proof of work.
  test('recovers backlog task even when session does not exist locally', async () => {
    const ref = await makeBacklogTask(env, 'moved between machines');
    makeBranchWithCommits(env, ref, 2);

    // Sanity check: no session for this task.
    expect(await env.storage.getSessionByTaskId(ref)).toBeNull();

    await recoverBacklogWithCommits(env.storage, env.lazyRoot);

    const task = await env.storage.getTask(ref);
    expect(task?.status).toBe('blocked');
  });

  // INVARIANT 2: backlog with branch but no commits → stays backlog.
  // A branch can exist with zero commits ahead of base (e.g. `lazy start`
  // created the branch then crashed before the first commit). That's still
  // genuinely "unstarted" — recovery must not fire.
  test('does NOT recover backlog task whose branch has no commits beyond base', async () => {
    const ref = await makeBacklogTask(env, 'empty branch');
    makeBranchWithCommits(env, ref, 0);

    await recoverBacklogWithCommits(env.storage, env.lazyRoot);

    const task = await env.storage.getTask(ref);
    expect(task?.status).toBe('backlog');
  });

  // INVARIANT 2: backlog with no branch at all → stays backlog.
  // The default state — no work done anywhere — must be preserved.
  test('does NOT recover backlog task with no branch', async () => {
    const ref = await makeBacklogTask(env, 'never started');

    await recoverBacklogWithCommits(env.storage, env.lazyRoot);

    const task = await env.storage.getTask(ref);
    expect(task?.status).toBe('backlog');
  });

  // INVARIANT 3: the transition is `backlog → blocked` and goes through the
  // state machine. updateTaskStatus calls assertValidTransition internally,
  // so if the table didn't list this transition the sweep would throw and
  // the task would stay backlog. This test pins the state-machine wiring.
  test('uses the canonical state-machine transition (no ad-hoc bypass)', async () => {
    const ref = await makeBacklogTask(env, 'state machine wiring');
    makeBranchWithCommits(env, ref, 1);

    // No throw → transition is permitted by the state machine table.
    await recoverBacklogWithCommits(env.storage, env.lazyRoot);

    const task = await env.storage.getTask(ref);
    expect(task?.status).toBe('blocked');
  });

  // Mixed batch: only the tasks that actually have work get recovered.
  // Verifies the sweep applies its check per-task, not all-or-nothing.
  test('handles mixed batch correctly', async () => {
    const withWorkRef = await makeBacklogTask(env, 'has work');
    makeBranchWithCommits(env, withWorkRef, 1);
    const emptyBranchRef = await makeBacklogTask(env, 'empty branch');
    makeBranchWithCommits(env, emptyBranchRef, 0);
    const noBranchRef = await makeBacklogTask(env, 'no branch');

    await recoverBacklogWithCommits(env.storage, env.lazyRoot);

    expect((await env.storage.getTask(withWorkRef))?.status).toBe('blocked');
    expect((await env.storage.getTask(emptyBranchRef))?.status).toBe('backlog');
    expect((await env.storage.getTask(noBranchRef))?.status).toBe('backlog');
  });
});
