import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join, dirname } from 'path';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, expectOutputExcludes } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';
import { findFullTaskId, setTaskMetadata, setTaskStatus, taskFilePath, worktreePathFor } from '../helpers/storage';

/** The lock path lazy actually uses — see getPairingLockPath in src/utils/pairing-lock.ts. */
function pairingLockPath(root: string, shortId: string): string {
  return join(worktreePathFor(root, shortId), '.lazy-task-sandbox', 'pairing-lock');
}

/**
 * Helper: place a pairing lock on a task's worktree that appears alive.
 *
 * The lock MUST land in `.lazy-task-sandbox/`, not `.lazy/`: that directory is
 * excluded from every dirty-worktree check (`git status --porcelain --
 * ':!.lazy-task-sandbox'`), so a lock does not make the worktree dirty. Writing
 * it to `.lazy/` instead both hid the lock from `checkPairingLock` and tripped
 * accept/reject's dirty gate before their pairing gate could fire.
 */
function placePairingLock(root: string, shortId: string): void {
  const lockPath = pairingLockPath(root, shortId);
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid, // Test runner PID — alive while subprocess runs
    started_at: new Date().toISOString(),
    user: 'test',
  }, null, 2));
}

interface ManualSessionOptions {
  /**
   * Check `lazy/<shortId>` out in the MAIN repo and leave the worktree on a
   * detached HEAD instead of on the branch.
   *
   * Only branch-detection tests need this. Git refuses to check out a branch
   * that is already checked out in a worktree ("fatal: 'lazy/x' is already
   * checked out at ..."), so with the default (attached) layout a
   * `ctx.git('checkout', branch)` silently fails and the main repo stays on
   * `main` — which is why those tests were exercising branchless pairing while
   * claiming to exercise branch detection.
   */
  checkoutBranchInMainRepo?: boolean;
}

/**
 * Helper: create a session.json manually for a task (no Docker needed).
 * Also creates the worktree directory and git branch.
 */
function createSessionManually(ctx: TestContext, shortId: string, options: ManualSessionOptions = {}): void {
  const fullTaskId = findFullTaskId(ctx.root, shortId);

  const branchName = `lazy/${shortId}`;
  const startSha = ctx.git('rev-parse', 'HEAD').stdout.trim();

  // Create the git worktree and branch
  const worktreePath = worktreePathFor(ctx.root, shortId);
  mkdirSync(dirname(worktreePath), { recursive: true });
  if (options.checkoutBranchInMainRepo) {
    ctx.git('worktree', 'add', '--detach', worktreePath, 'HEAD');
    const checkout = ctx.git('checkout', '-b', branchName);
    if (checkout.exitCode !== 0) {
      throw new Error(`failed to check out ${branchName} in the main repo: ${checkout.stderr}`);
    }
  } else {
    ctx.git('worktree', 'add', worktreePath, '-b', branchName);
  }

  // Write session.json
  const session = {
    id: randomUUID(),
    task_id: fullTaskId,
    agent_id: 'claude-code',
    started_at: Date.now(),
    ended_at: null,
    outcome: null,
    git_branch: branchName,
    git_start_sha: startSha,
    agent_session_id: null,
    last_interaction_at: Date.now(),
    total_duration_ms: 0,
    total_usage: null,
    container_name: null,
    interrupt_reason: null,
    interrupt_exit_code: null,
    interrupt_at: null,
    interrupt_logs: null,
    consecutive_interruptions: 0,
    auto_resumed: false,
  };
  writeFileSync(taskFilePath(ctx.root, shortId, 'session.json'), JSON.stringify(session, null, 2));
}

describe('lazy pair', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: When on main (non-task branch) with no argument, pair launches
  // branchless mode — Claude Code in the current directory with conversation capture.
  test('launches branchless pairing on non-task branch', async () => {
    // On main branch (default in test repos), `lazy pair` should attempt
    // to launch Claude Code without task context. It will fail because
    // the `claude` binary doesn't exist, but should NOT show usage.
    const result = await ctx.lazy(['pair']);
    expectOutputExcludes(result, 'Usage: lazy pair');
    expectOutput(result, 'Launching Claude Code');
    expectOutput(result, 'no task context');
  });

  // INVARIANT: When on a lazy/* branch with no argument, pair detects the task.
  test('detects task from lazy/* branch', async () => {
    const taskId = await createTask(ctx, 'Branch detection task', 'Some work');
    // Puts the main repo on lazy/<taskId> — the state branch detection reads.
    createSessionManually(ctx, taskId, { checkoutBranchInMainRepo: true });
    setTaskStatus(ctx.root, taskId, 'blocked');

    // Running `lazy pair` without arguments should detect the task from the
    // branch. With a credential present (the default fake key, so the daemon
    // gate passes), pair resolves the task and proceeds to the launch step,
    // printing the resume message — proving it detected the task from the
    // lazy/* branch. (It ultimately fails later because the `claude` binary
    // isn't installed in the test env.)
    const result = await ctx.lazy(['pair']);

    expectOutputExcludes(result, 'Usage: lazy pair');
    expectOutput(result, 'No existing Claude session to resume');
  });

  test('--unlock fails without task on non-task branch', async () => {
    const result = await ctx.lazy(['pair', '--unlock']);
    expectFailure(result);
    expectError(result, '--unlock requires a task argument');
  });

  test('fails when task has no session', async () => {
    const taskId = await createTask(ctx, 'Not started task', 'Some work');

    const result = await ctx.lazy(['pair', taskId]);

    expectFailure(result);
    expectError(result, 'has no session');
  });

  test('fails when task is working', async () => {
    const taskId = await createTask(ctx, 'Working task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'working');

    const result = await ctx.lazy(['pair', taskId]);

    expectFailure(result);
    expectError(result, 'currently working');
  });

  test('--unlock removes pairing lock', async () => {
    const taskId = await createTask(ctx, 'Task with lock', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'blocked');

    // Place a pairing lock that appears alive
    placePairingLock(ctx.root, taskId);

    const lockPath = pairingLockPath(ctx.root, taskId);

    // Verify lock file exists
    expect(existsSync(lockPath)).toBe(true);

    const result = await ctx.lazy(['pair', taskId, '--unlock']);

    expectSuccess(result);
    expectOutput(result, 'Pairing lock removed');

    // Lock file should be gone
    expect(existsSync(lockPath)).toBe(false);
  });

  test('--unlock reports when no lock exists', async () => {
    const taskId = await createTask(ctx, 'Task without lock', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'blocked');

    const result = await ctx.lazy(['pair', taskId, '--unlock']);

    expectSuccess(result);
    expectOutput(result, 'No pairing lock found');
  });

  test('--unlock restores pairing state to blocked', async () => {
    const taskId = await createTask(ctx, 'Task stuck in pairing', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'pairing');
    setTaskMetadata(ctx.root, taskId, 'pairing_pid', String(process.pid));
    placePairingLock(ctx.root, taskId);

    const result = await ctx.lazy(['pair', taskId, '--unlock']);

    expectSuccess(result);
    expectOutput(result, 'Pairing lock removed');
    expectOutput(result, 'status restored to blocked');

    // Verify task is now blocked
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'blocked');
  });

  test('fails when another pairing session is active', async () => {
    const taskId = await createTask(ctx, 'Already paired task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'blocked');

    // Place a pairing lock that appears alive
    placePairingLock(ctx.root, taskId);

    const result = await ctx.lazy(['pair', taskId]);

    expectFailure(result);
    expectError(result, 'already being paired on');
  });

  // INVARIANT: pair does NOT enforce auth itself — the daemon credential gate
  // is the single enforcement point. `lazy pair` auto-starts the daemon, which
  // refuses to start without a credential. So a missing credential surfaces as
  // the daemon's actionable error (clients pass through, they don't re-enforce).
  // This is the behavior that makes dropping the old client-side check safe.
  //
  // `LAZY_TEST: ''` is load-bearing: a daemonless suite runs the CLI with
  // LAZY_TEST=1, under which ensureDaemon() returns early and no daemon is ever
  // started — so the gate could never fire and the test would sail past into
  // the launch step. Clearing it restores the real auto-start path (same
  // technique as daemon.test.ts's credential-gate block). No daemon leaks: the
  // gate is exactly what stops it from coming up.
  test('missing credential surfaces the daemon gate error, not a client check', async () => {
    const taskId = await createTask(ctx, 'No auth task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'blocked');

    const result = await ctx.lazy(['pair', taskId], {
      env: {
        LAZY_TEST: '',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        ANTHROPIC_API_KEY: '',
      },
    });

    expectFailure(result);
    // The daemon gate fired — not the old client-side "No API token found".
    expectError(result, 'Daemon refuses to start');
    expectError(result, 'ANTHROPIC_API_KEY');
    expectOutputExcludes(result, 'No API token found');
  });

  // INVARIANT: the daemon gate is not bypassable by client flags. --no-summary
  // used to skip pair's local auth check; now there is no client check, and the
  // daemon still requires a credential regardless of the flag.
  test('--no-summary does not bypass the daemon credential gate', async () => {
    const taskId = await createTask(ctx, 'No auth task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'blocked');

    const result = await ctx.lazy(['pair', taskId, '--no-summary'], {
      env: {
        LAZY_TEST: '',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        ANTHROPIC_API_KEY: '',
      },
    });

    expectFailure(result);
    expectError(result, 'Daemon refuses to start');
  });

  test('proceeds past the gate when a credential is available', async () => {
    const taskId = await createTask(ctx, 'Auth task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'blocked');

    // Credential present (default fake key) → daemon gate passes, pair resolves
    // the task and reaches the launch step. It fails later because the `claude`
    // binary doesn't exist, but it must NOT fail with the credential gate error.
    const result = await ctx.lazy(['pair', taskId]);

    expectOutputExcludes(result, 'Daemon refuses to start');
    expectOutput(result, 'No existing Claude session to resume');
  });

  // INVARIANT: --resume is only valid in branchless mode.
  // Task-based pairing resumes sessions automatically via agent_session_id.
  test('--resume works in branchless mode', async () => {
    // On main branch (no task context), `lazy pair --resume` should attempt
    // to launch Claude Code with the --resume flag. It will fail because
    // the `claude` binary doesn't exist, but should show branchless launch message.
    const result = await ctx.lazy(['pair', '--resume', 'abc123session']);
    expectOutputExcludes(result, 'Usage: lazy pair');
    expectOutput(result, 'Launching Claude Code');
    expectOutput(result, 'no task context');
  });

  test('--resume fails when task ID is explicitly provided', async () => {
    const taskId = await createTask(ctx, 'Explicit task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'blocked');

    const result = await ctx.lazy(['pair', taskId, '--resume', 'abc123session']);

    expectFailure(result);
    expectError(result, '--resume is only valid in branchless mode');
    expectError(result, 'Task-based pairing resumes sessions automatically');
  });

  test('--resume fails when on task branch (detected task)', async () => {
    const taskId = await createTask(ctx, 'Branch-detected task', 'Some work');
    // Puts the main repo on lazy/<taskId> — the state branch detection reads.
    createSessionManually(ctx, taskId, { checkoutBranchInMainRepo: true });
    setTaskStatus(ctx.root, taskId, 'blocked');

    // Running `lazy pair --resume` should detect the task and reject the flag
    const result = await ctx.lazy(['pair', '--resume', 'abc123session']);

    expectFailure(result);
    expectError(result, '--resume is only valid in branchless mode');
    expectError(result, 'Task-based pairing resumes sessions automatically');
  });
});

describe('pairing state blocks operations', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * Helper: create a task with a session and worktree, set to pairing state
   * with a live PID in metadata (prevents stale pairing sweep from clearing it).
   */
  async function createPairingTask(): Promise<string> {
    const taskId = await createTask(ctx, 'Pairing task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'pairing');
    // Set pairing_pid to a PID that's alive (test runner process)
    // This prevents the reconciler's stale pairing sweep from transitioning back to blocked
    setTaskMetadata(ctx.root, taskId, 'pairing_pid', String(process.pid));
    setTaskMetadata(ctx.root, taskId, 'pairing_started_at', new Date().toISOString());
    return taskId;
  }

  // INVARIANT: pair accepts blocked | conflict | interrupted and nothing else
  // (docs/state-machine.md: "lazy pair <task> — blocked|conflict|interrupted →
  // pairing"). This test used to assert that `interrupted` was REJECTED, which
  // has been wrong since v0.9 made interrupted pairable — it only ever passed
  // because pair failed later for an unrelated reason.
  test('pair refuses a task in a non-pairable state', async () => {
    const taskId = await createTask(ctx, 'Backlog task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'backlog');

    const result = await ctx.lazy(['pair', taskId]);

    expectFailure(result);
    expectError(result, "is in state 'backlog'");
    expectError(result, 'Can only pair with blocked, conflict, or interrupted tasks');
  });

  test('pair accepts an interrupted task', async () => {
    const taskId = await createTask(ctx, 'Interrupted task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'interrupted');

    const result = await ctx.lazy(['pair', taskId]);

    // Reached the launch step — the state gate let `interrupted` through.
    expectOutput(result, 'No existing Claude session to resume');
  });

  test('pair rejects task already in pairing state', async () => {
    const taskId = await createPairingTask();

    const result = await ctx.lazy(['pair', taskId]);

    expectFailure(result);
    expectError(result, 'already in a pairing session');
  });

  test('accept refuses when task is in pairing state', async () => {
    const taskId = await createPairingTask();

    const result = await ctx.lazy(['accept', taskId, '--yes']);

    expectFailure(result);
    expectError(result, 'locked (pairing in progress)');
  });

  test('reject refuses when task is in pairing state', async () => {
    const taskId = await createPairingTask();

    const result = await ctx.lazy(['reject', taskId, '--reason', 'bad', '--yes']);

    expectFailure(result);
    expectError(result, 'locked (pairing in progress)');
  });

  test('unblock refuses when task is in pairing state', async () => {
    const taskId = await createPairingTask();

    const result = await ctx.lazy(['unblock', taskId, '--message', 'test feedback']);

    expectFailure(result);
    expectError(result, 'locked (pairing in progress)');
  });

  test('close refuses when task is in pairing state', async () => {
    const taskId = await createPairingTask();

    const result = await ctx.lazy(['close', taskId, '--reason', 'done']);

    expectFailure(result);
    expectError(result, 'locked (pairing in progress)');
  });

  test('show displays pairing status', async () => {
    const taskId = await createPairingTask();

    const result = await ctx.lazy(['show', taskId]);

    expectSuccess(result);
    expectOutput(result, 'pairing');
  });
});

describe('pairing lock blocks other commands', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * Helper: create a task with a session and worktree, set to blocked status.
   */
  async function createPairedTask(): Promise<string> {
    const taskId = await createTask(ctx, 'Paired task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'blocked');
    return taskId;
  }

  test('unblock refuses when task is locked for pairing', async () => {
    const taskId = await createPairedTask();
    placePairingLock(ctx.root, taskId);

    const result = await ctx.lazy(['unblock', taskId, '--message', 'test feedback']);

    expectFailure(result);
    expectError(result, 'locked for pairing');
  });

  test('accept with dirty worktree refuses with uncommitted error (before pairing check)', async () => {
    const taskId = await createPairedTask();
    const worktreePath = worktreePathFor(ctx.root, taskId);

    // Create a REAL uncommitted change (not just the pairing lock file)
    writeFileSync(join(worktreePath, 'dirty-file.txt'), 'uncommitted changes\n');

    // Place pairing lock — dirty check should catch the uncommitted change first
    placePairingLock(ctx.root, taskId);

    const result = await ctx.lazy(['accept', taskId, '--yes']);

    expectFailure(result);
    // Dirty worktree check comes FIRST, even though pairing lock is also present
    expectError(result, 'uncommitted changes');
  });

  test('accept refuses when task is locked for pairing (clean worktree)', async () => {
    const taskId = await createPairedTask();
    placePairingLock(ctx.root, taskId);

    const result = await ctx.lazy(['accept', taskId, '--yes']);

    expectFailure(result);
    expectError(result, 'locked for pairing');
  });

  test('reject with dirty worktree refuses with uncommitted error (before pairing check)', async () => {
    const taskId = await createPairedTask();
    const worktreePath = worktreePathFor(ctx.root, taskId);

    // Create a REAL uncommitted change (not just the pairing lock file)
    writeFileSync(join(worktreePath, 'dirty-file.txt'), 'uncommitted changes\n');

    // Place pairing lock — dirty check should catch the uncommitted change first
    placePairingLock(ctx.root, taskId);

    const result = await ctx.lazy(['reject', taskId, '--reason', 'bad', '--yes']);

    expectFailure(result);
    // Dirty worktree check comes FIRST, even though pairing lock is also present
    expectError(result, 'uncommitted changes');
  });

  test('reject refuses when task is locked for pairing (clean worktree)', async () => {
    const taskId = await createPairedTask();
    placePairingLock(ctx.root, taskId);

    const result = await ctx.lazy(['reject', taskId, '--reason', 'bad', '--yes']);

    expectFailure(result);
    expectError(result, 'locked for pairing');
  });

  test('resume refuses when task is locked for pairing', async () => {
    const taskId = await createPairedTask();
    placePairingLock(ctx.root, taskId);

    // Set task to interrupted so resume can be attempted
    setTaskStatus(ctx.root, taskId, 'interrupted');

    const result = await ctx.lazy(['resume', taskId]);

    expectFailure(result);
    expectError(result, 'locked for pairing');
  });
});
