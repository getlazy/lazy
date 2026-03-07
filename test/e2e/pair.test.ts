import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { writeFileSync, existsSync, readFileSync, readdirSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, expectOutputExcludes } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * Helper: find the full task UUID directory name from a short ID prefix.
 */
function findFullTaskId(root: string, shortId: string): string | undefined {
  const tasksDir = join(root, '.lazy', 'tasks');
  const taskDirs = readdirSync(tasksDir);
  return taskDirs.find(d => d.startsWith(shortId));
}

/**
 * Helper: manually set a task's status in task.json.
 * Useful because the mock start + reconciliation may leave the task in a
 * different state than needed for a particular test scenario.
 */
function setTaskStatus(root: string, shortId: string, status: string): void {
  const fullTaskId = findFullTaskId(root, shortId);
  if (!fullTaskId) throw new Error(`Task not found: ${shortId}`);
  const taskJsonPath = join(root, '.lazy', 'tasks', fullTaskId, 'task.json');
  const taskData = JSON.parse(readFileSync(taskJsonPath, 'utf-8'));
  taskData.status = status;
  writeFileSync(taskJsonPath, JSON.stringify(taskData, null, 2));
}

/**
 * Helper: set task metadata in task.json.
 */
function setTaskMetadata(root: string, shortId: string, key: string, value: string): void {
  const fullTaskId = findFullTaskId(root, shortId);
  if (!fullTaskId) throw new Error(`Task not found: ${shortId}`);
  const taskJsonPath = join(root, '.lazy', 'tasks', fullTaskId, 'task.json');
  const taskData = JSON.parse(readFileSync(taskJsonPath, 'utf-8'));
  if (!taskData.metadata) taskData.metadata = {};
  taskData.metadata[key] = value;
  writeFileSync(taskJsonPath, JSON.stringify(taskData, null, 2));
}

/**
 * Helper: place a pairing lock on a task's worktree that appears alive
 * (uses PID 1, which is always running on any Unix system).
 */
function placePairingLock(root: string, shortId: string): void {
  const worktreePath = join(root, '.lazy', 'worktrees', shortId);
  const lockPath = join(worktreePath, '.lazy-pairing');
  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid, // Test runner PID — alive while subprocess runs
    started_at: new Date().toISOString(),
    user: 'test',
  }, null, 2));
}

/**
 * Helper: create a session.json manually for a task (no Docker needed).
 * Also creates the worktree directory and git branch.
 */
function createSessionManually(ctx: TestContext, shortId: string): void {
  const fullTaskId = findFullTaskId(ctx.root, shortId);
  if (!fullTaskId) throw new Error(`Task not found: ${shortId}`);

  const branchName = `lazy/${shortId}`;
  const startSha = ctx.git('rev-parse', 'HEAD').stdout.trim();

  // Create the git worktree and branch
  const worktreePath = join(ctx.root, '.lazy', 'worktrees', shortId);
  mkdirSync(join(ctx.root, '.lazy', 'worktrees'), { recursive: true });
  ctx.git('worktree', 'add', worktreePath, '-b', branchName);

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
  const sessionPath = join(ctx.root, '.lazy', 'tasks', fullTaskId, 'session.json');
  writeFileSync(sessionPath, JSON.stringify(session, null, 2));
}

describe('lazy pair', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('shows usage when no task ID provided', async () => {
    const result = await ctx.lazy(['pair']);
    expectFailure(result);
    expectOutput(result, 'Usage: lazy pair');
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

    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const lockPath = join(worktreePath, '.lazy-pairing');

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

  // INVARIANT: Pairing requires an API token for post-session summarization.
  // Without a token, summarization would silently fail, losing valuable context.
  test('fails when no API token is available', async () => {
    const taskId = await createTask(ctx, 'No auth task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'blocked');

    const result = await ctx.lazy(['pair', taskId], {
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: '',
        ANTHROPIC_API_KEY: '',
      },
    });

    expectFailure(result);
    expectError(result, 'No API token found');
    expectError(result, '--no-summary');
  });

  test('--no-summary bypasses auth check', async () => {
    const taskId = await createTask(ctx, 'No auth task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'blocked');

    // With --no-summary and no auth, the command should proceed past the auth
    // check. It will still fail because `claude` binary doesn't exist, but the
    // auth error should NOT appear.
    const result = await ctx.lazy(['pair', taskId, '--no-summary'], {
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: '',
        ANTHROPIC_API_KEY: '',
      },
    });

    // Should not fail with auth error (may fail for other reasons like no claude binary)
    expectOutputExcludes(result, 'No API token found');
  });

  test('does not fail auth check when API token is available', async () => {
    const taskId = await createTask(ctx, 'Auth task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'blocked');

    // Run pair with an API key set. The command will fail because `claude`
    // binary doesn't exist, but the auth error should NOT appear.
    const result = await ctx.lazy(['pair', taskId], {
      env: {
        ANTHROPIC_API_KEY: 'sk-test-fake-key-for-testing',
      },
    });

    expectOutputExcludes(result, 'No API token found');
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

  test('pair requires task to be in blocked state', async () => {
    const taskId = await createTask(ctx, 'Interrupted task', 'Some work');
    createSessionManually(ctx, taskId);
    setTaskStatus(ctx.root, taskId, 'interrupted');

    const result = await ctx.lazy(['pair', taskId]);

    expectFailure(result);
    expectError(result, "not 'blocked'");
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
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);

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
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);

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
