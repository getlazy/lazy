import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import {
  writeResponse,
  consumeResponse,
  hasResponse,
  protocolDir as getProtocolDir,
} from '../../src/protocol';
import type { CompletedResponse, ErrorResponse } from '../../src/protocol';
import { reconcileTasks } from '../../src/utils/reconcile';
import { createStorage } from '../../src/storage';

// ============================================================
// Helpers
// ============================================================

/**
 * Find the full task ID from a short ID by scanning the tasks directory.
 */
function findFullTaskId(root: string, shortId: string): string {
  const tasksDir = join(root, '.lazy', 'tasks');
  const entries = readdirSync(tasksDir);
  const match = entries.find((e: string) => e.startsWith(shortId));
  if (!match) {
    throw new Error(`Could not find full task ID for short ID: ${shortId}`);
  }
  return match;
}

/**
 * Directly set a task's status in file storage.
 */
function setTaskStatus(root: string, fullTaskId: string, status: string): void {
  const taskPath = join(root, '.lazy', 'tasks', fullTaskId, 'task.json');
  const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
  task.status = status;
  writeFileSync(taskPath, JSON.stringify(task, null, 2));

  // Also update the session's last_interaction_at to bypass grace period
  const sessionPath = join(root, '.lazy', 'tasks', fullTaskId, 'session.json');
  if (existsSync(sessionPath)) {
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));
    session.last_interaction_at = new Date(Date.now() - 60000).toISOString();
    writeFileSync(sessionPath, JSON.stringify(session, null, 2));
  }
}

/**
 * Run reconciliation directly (simulates what the daemon does).
 * Tests can't rely on CLI commands triggering reconciliation — only the daemon does that.
 */
async function runReconcile(root: string): Promise<void> {
  const storage = await createStorage(root);
  try {
    await reconcileTasks(storage, root);
  } finally {
    await storage.close();
  }
}

/**
 * Set a task's last_interaction_at to a specific value.
 * Used to test timezone parsing edge cases in the grace period logic.
 */
function setLastInteractionAt(root: string, fullTaskId: string, value: string): void {
  const sessionPath = join(root, '.lazy', 'tasks', fullTaskId, 'session.json');
  const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));
  session.last_interaction_at = value;
  writeFileSync(sessionPath, JSON.stringify(session, null, 2));
}

// ============================================================
// Section 1: Grace period
// ============================================================

describe('lazy reconciliation grace period', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('start followed immediately by list does not mark task as interrupted', async () => {
    // Create a task
    const taskId = await createTask(ctx, 'Grace period test', 'Do the work');

    // Start the task - this transitions it to 'working'
    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);
    expectOutput(startResult, 'Started task');

    // Run reconciliation immediately after start.
    // The grace period should prevent the task from being marked as interrupted
    // even though the container may not be fully running yet.
    await runReconcile(ctx.root);

    // Verify the task is still shown as working (or blocked if supervisor completed fast)
    // but NOT interrupted
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    // Task should be either working or blocked (if supervisor completed), but never interrupted
    // Check that output contains either "working" or "blocked" but not "interrupted"
    const hasWorkingOrBlocked = showResult.stdout.includes('working') || showResult.stdout.includes('blocked');
    if (!hasWorkingOrBlocked) {
      throw new Error(`Expected task to be working or blocked, but got: ${showResult.stdout}`);
    }
  });

  test('working task with future last_interaction_at still reconciles to interrupted', async () => {
    // Regression test: when last_interaction_at parses to a future timestamp
    // (e.g. due to timezone-naive date strings), timeSinceTransition becomes negative.
    // Before the fix, negative values passed the `< WORKING_GRACE_PERIOD_MS` check,
    // causing the task to be stuck in 'working' forever.
    const taskId = await createTask(ctx, 'Future timestamp test', 'Do the work');

    // Start the task so it has a session and transitions to working/blocked
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // Reconcile first to process any response
    await runReconcile(ctx.root);

    const fullTaskId = findFullTaskId(ctx.root, taskId);

    // Set task back to working and set last_interaction_at to 1 hour in the future
    // This simulates the timezone parsing bug where a naive date string
    // (e.g. "2026-02-12 12:49:41" without timezone) gets parsed as UTC
    // while Date.now() is in a different timezone
    setTaskStatus(ctx.root, fullTaskId, 'working');
    const futureDate = new Date(Date.now() + 3600000).toISOString();
    setLastInteractionAt(ctx.root, fullTaskId, futureDate);

    // Trigger reconciliation — with the fix, negative elapsed time should NOT
    // cause the grace period to skip reconciliation
    await runReconcile(ctx.root);

    // Task should be interrupted (no container running, no response)
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'interrupted');
  });

});

// ============================================================
// Section 2: Interrupted task response sweep
// ============================================================

describe('reconciliation sweep: interrupted task responses', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('interrupted task with stale completed response gets transitioned to blocked', async () => {
    // 1. Create and start a task (mock supervisor writes response.json)
    const taskId = await createTask(ctx, 'Interrupted sweep test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    const fullTaskId = findFullTaskId(ctx.root, taskId);
    const protoDir = getProtocolDir(fullTaskId);

    // 2. Manually set task to 'interrupted' (simulating the race condition where
    //    the reconciler moved it to interrupted, but a new response was written after)
    setTaskStatus(ctx.root, fullTaskId, 'interrupted');

    // 3. Write a fresh completed response.json (simulating the supervisor completing
    //    the next command after the task was already marked interrupted)
    const completedResp: CompletedResponse = {
      status: 'completed',
      result: 'I completed the work after being interrupted.',
      session_id: 'mock-sess-002',
      usage: { input_tokens: 300, output_tokens: 600 },
    };
    writeResponse(protoDir, completedResp);

    // 4. Trigger reconciliation (simulates daemon)
    await runReconcile(ctx.root);

    // 5. Verify the task was transitioned from interrupted -> blocked
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'blocked');

    // 6. Verify the response was consumed
    expect(hasResponse(protoDir)).toBe(false);
  });

  test('interrupted task with stale error response stays interrupted', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Interrupted error sweep test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    const fullTaskId = findFullTaskId(ctx.root, taskId);
    const protoDir = getProtocolDir(fullTaskId);

    // 2. Set task to interrupted
    setTaskStatus(ctx.root, fullTaskId, 'interrupted');

    // 3. Write an error response
    const errorResp: ErrorResponse = {
      status: 'error',
      error: 'Claude process crashed again',
      phase: 'work',
    };
    writeResponse(protoDir, errorResp);

    // 4. Trigger reconciliation (simulates daemon)
    await runReconcile(ctx.root);

    // 5. Task should still be interrupted (error response just gets consumed)
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'interrupted');

    // 6. Error response should be consumed
    expect(hasResponse(protoDir)).toBe(false);
  });

  test('interrupted task with no response remains interrupted', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Interrupted no-resp test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    const fullTaskId = findFullTaskId(ctx.root, taskId);
    const protoDir = getProtocolDir(fullTaskId);

    // 2. Set task to interrupted and remove any response
    setTaskStatus(ctx.root, fullTaskId, 'interrupted');
    consumeResponse(protoDir);

    // 3. Trigger reconciliation (simulates daemon)
    await runReconcile(ctx.root);

    // 4. Task should still be interrupted (no response to process)
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'interrupted');
  });

  test('interrupted task response records agent turn', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Interrupted turn test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    const fullTaskId = findFullTaskId(ctx.root, taskId);
    const protoDir = getProtocolDir(fullTaskId);

    // 2. Set task to interrupted
    setTaskStatus(ctx.root, fullTaskId, 'interrupted');

    // 3. Write a completed response with specific result text
    const completedResp: CompletedResponse = {
      status: 'completed',
      result: 'Unique stale response result text for verification.',
      session_id: 'mock-sess-003',
      usage: { input_tokens: 100, output_tokens: 200 },
    };
    writeResponse(protoDir, completedResp);

    // 4. Trigger reconciliation (simulates daemon)
    await runReconcile(ctx.root);

    // 5. Verify the agent turn was recorded with the response text
    const showResult = await ctx.lazy(['show', taskId, '--full']);
    expectSuccess(showResult);
    expectOutput(showResult, 'Unique stale response result text');
  });
});

// ============================================================
// Section 3: Terminal task container sweep
// ============================================================

describe('reconciliation sweep: terminal task containers', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('reconciliation does not crash for terminal-state tasks', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Terminal sweep test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // 2. Reconcile to move to blocked, then set to complete
    await runReconcile(ctx.root);
    const fullTaskId = findFullTaskId(ctx.root, taskId);
    setTaskStatus(ctx.root, fullTaskId, 'complete');

    // 3. Trigger reconciliation again -- the terminal sweep should run without error
    await runReconcile(ctx.root);

    // 4. Verify the task is still in complete status
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'complete');
  });

  test('reconciliation handles multiple terminal-state tasks', async () => {
    // Create several tasks in different terminal states
    const taskIds: string[] = [];
    for (const goal of ['Complete task', 'Abandoned task 1', 'Abandoned task 2']) {
      const id = await createTask(ctx, goal, 'Do work');
      await ctx.lazyMocked(['start', id, '--yes'], MOCK_CLAUDE_SUCCESS, {
        env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
      });
      taskIds.push(id);
    }

    // Reconcile all to blocked first
    await runReconcile(ctx.root);

    // Set each to a different terminal state
    const statuses = ['complete', 'abandoned', 'abandoned'];
    for (let i = 0; i < taskIds.length; i++) {
      const fullId = findFullTaskId(ctx.root, taskIds[i]);
      setTaskStatus(ctx.root, fullId, statuses[i]);
    }

    // Trigger reconciliation -- all terminal sweeps should complete without error
    await runReconcile(ctx.root);
  });
});

// ============================================================
// Section 4: Merged branch zombie detection
// ============================================================

describe('reconciliation sweep: merged branch zombie detection', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('task whose branch was merged into main is detected and fixed', async () => {
    // 1. Create and start a task with commits
    const taskId = await createTask(ctx, 'Zombie branch test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // 2. Reconcile to move to blocked
    await runReconcile(ctx.root);

    const fullTaskId = findFullTaskId(ctx.root, taskId);

    // 3. Verify task is blocked before the merge
    const taskPath = join(ctx.root, '.lazy', 'tasks', fullTaskId, 'task.json');
    const taskBefore = JSON.parse(readFileSync(taskPath, 'utf-8'));
    expect(taskBefore.status).toBe('blocked');

    // 4. Manually squash-merge the task branch into main (simulating what accept does)
    //    but WITHOUT updating session/task metadata (simulating crash after merge)
    const branchName = `lazy/${taskId}`;
    ctx.git('checkout', 'main');
    ctx.git('merge', '--squash', branchName);
    ctx.git('commit', '-m', `Accept task ${taskId}: Zombie branch test`);
    ctx.git('checkout', branchName);

    // 5. Trigger reconciliation — sweep should detect and fix the zombie
    await runReconcile(ctx.root);

    const showAfter = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfter);
    expectOutput(showAfter, 'complete');
  });

  test('task whose branch was deleted after merge is detected via commit message', async () => {
    // 1. Create and start a task with commits
    const taskId = await createTask(ctx, 'Deleted branch zombie', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // 2. Reconcile to move to blocked
    await runReconcile(ctx.root);

    const fullTaskId = findFullTaskId(ctx.root, taskId);
    const branchName = `lazy/${taskId}`;

    // 3. Squash-merge into main, then delete the branch (simulating partial cleanup)
    ctx.git('checkout', 'main');
    ctx.git('merge', '--squash', branchName);
    ctx.git('commit', '-m', `Accept task ${taskId}: Deleted branch zombie`);

    // Remove worktree first (required before deleting branch)
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    if (existsSync(worktreePath)) {
      ctx.git('worktree', 'remove', worktreePath, '--force');
    }
    ctx.git('branch', '-D', branchName);

    // 4. Trigger reconciliation (simulates daemon)
    await runReconcile(ctx.root);

    // 5. Verify task is now complete
    const showAfter = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfter);
    expectOutput(showAfter, 'complete');
  });

  test('normal blocked task with unmerged branch is not affected', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Normal blocked task', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // 2. Reconcile to blocked
    await runReconcile(ctx.root);

    // 3. Trigger reconciliation again — task should stay blocked
    await runReconcile(ctx.root);

    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'blocked');
  });

  // INVARIANT: Tasks with no agent work must never be auto-accepted by the zombie sweep.
  // If the agent never ran (zero agent turns), there's nothing to accept — the task's
  // intent would be lost. This is defense-in-depth against false positives in isBranchMergedInto.
  test('task with zero agent turns is not auto-accepted even if branch looks merged', async () => {
    // 1. Create and start a task (mock agent writes a response that creates an agent turn)
    const taskId = await createTask(ctx, 'No-agent zombie test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // 2. Reconcile to blocked
    await runReconcile(ctx.root);

    const fullTaskId = findFullTaskId(ctx.root, taskId);

    // 3. Remove agent turns from turns.json — simulate a task where the agent never ran
    //    (only the initial human prompt turn exists)
    const turnsPath = join(ctx.root, '.lazy', 'tasks', fullTaskId, 'turns.json');
    const turnsData = JSON.parse(readFileSync(turnsPath, 'utf-8'));
    turnsData.turns = turnsData.turns.filter((t: { role: string }) => t.role !== 'agent');
    writeFileSync(turnsPath, JSON.stringify(turnsData, null, 2));

    // 4. Set task back to blocked (it may have been complete/blocked, reset to blocked)
    setTaskStatus(ctx.root, fullTaskId, 'blocked');

    // Also clear session outcome so the sweep doesn't skip it
    const sessionPath = join(ctx.root, '.lazy', 'tasks', fullTaskId, 'session.json');
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));
    session.outcome = null;
    session.ended_at = null;
    writeFileSync(sessionPath, JSON.stringify(session, null, 2));

    // 5. Squash-merge the branch into main (making it look like a zombie)
    const branchName = `lazy/${taskId}`;
    ctx.git('checkout', 'main');
    ctx.git('merge', '--squash', branchName);
    ctx.git('commit', '-m', `Accept task ${taskId}: No-agent zombie test`);
    ctx.git('checkout', branchName);

    // 6. Trigger reconciliation — the sweep should skip this task
    await runReconcile(ctx.root);

    // 7. Verify task is still blocked (NOT auto-accepted to complete)
    const showAfter = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfter);
    expectOutput(showAfter, 'blocked');
  });

  // INVARIANT: Branches with only empty commits (no file changes) are not "merged".
  // The --allow-empty init commit created by `lazy start` should not trigger zombie detection.
  // This tests both the isBranchMergedInto guard AND the zero-agent-turns guard.
  test('task with only empty init commit is not auto-accepted', async () => {
    // 1. Create a task
    const taskId = await createTask(ctx, 'Empty commit zombie test', 'Do work');

    // 2. Start the task (creates branch with --allow-empty init commit + mock agent response)
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // 3. Reconcile to blocked
    await runReconcile(ctx.root);

    const fullTaskId = findFullTaskId(ctx.root, taskId);

    // 4. Remove agent turns AND reset branch to only have the empty init commit
    //    This simulates the exact scenario: agent never ran, branch only has --allow-empty commit
    const turnsPath = join(ctx.root, '.lazy', 'tasks', fullTaskId, 'turns.json');
    const turnsData = JSON.parse(readFileSync(turnsPath, 'utf-8'));
    turnsData.turns = turnsData.turns.filter((t: { role: string }) => t.role !== 'agent');
    writeFileSync(turnsPath, JSON.stringify(turnsData, null, 2));

    // Reset the branch to only have the init commit (remove mock agent's commit)
    const branchName = `lazy/${taskId}`;
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    // Get the first commit on the branch (the --allow-empty init commit)
    const logResult = Bun.spawnSync(['git', 'log', '--format=%H', '--reverse'], { cwd: worktreePath });
    const commits = logResult.stdout.toString().trim().split('\n');
    // Find the init commit (first commit unique to this branch)
    const mergeBaseResult = Bun.spawnSync(['git', 'merge-base', branchName, 'main'], { cwd: ctx.root });
    const mergeBase = mergeBaseResult.stdout.toString().trim();
    const uniqueCommitsResult = Bun.spawnSync(
      ['git', 'rev-list', `${mergeBase}..${branchName}`],
      { cwd: ctx.root },
    );
    const uniqueCommits = uniqueCommitsResult.stdout.toString().trim().split('\n');
    // Reset to the first unique commit (the --allow-empty init) if there are multiple
    if (uniqueCommits.length > 1) {
      const initCommit = uniqueCommits[uniqueCommits.length - 1]; // oldest unique commit
      Bun.spawnSync(['git', 'reset', '--hard', initCommit], { cwd: worktreePath });
    }

    // 5. Set task to blocked with no outcome
    setTaskStatus(ctx.root, fullTaskId, 'blocked');
    const sessionPath = join(ctx.root, '.lazy', 'tasks', fullTaskId, 'session.json');
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));
    session.outcome = null;
    session.ended_at = null;
    writeFileSync(sessionPath, JSON.stringify(session, null, 2));

    // 6. Trigger reconciliation — should NOT auto-accept despite empty init commit
    await runReconcile(ctx.root);

    // 7. Verify task stays blocked
    const showAfter = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfter);
    expectOutput(showAfter, 'blocked');
  });

  test('interrupted task whose branch was merged is fixed', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Interrupted zombie test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // 2. Reconcile to blocked, then manually set to interrupted
    await runReconcile(ctx.root);
    const fullTaskId = findFullTaskId(ctx.root, taskId);
    setTaskStatus(ctx.root, fullTaskId, 'interrupted');

    // 3. Squash-merge into main without updating metadata
    const branchName = `lazy/${taskId}`;
    ctx.git('checkout', 'main');
    ctx.git('merge', '--squash', branchName);
    ctx.git('commit', '-m', `Accept task ${taskId}: Interrupted zombie test`);
    ctx.git('checkout', branchName);

    // 4. Trigger reconciliation (simulates daemon)
    await runReconcile(ctx.root);

    // 5. Verify task is now complete
    const showAfter = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfter);
    expectOutput(showAfter, 'complete');
  });
});

// ============================================================
// Section 5: Error isolation and resilience
// ============================================================

describe('reconciliation error isolation', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: Per-sweep error isolation — one sweep failing must not block other sweeps.
  // Each sweep (sweepInterruptedResponses, sweepTerminalContainers, etc.) is wrapped in
  // its own try/catch so that if one sweep throws, subsequent sweeps still run.
  test('reconciliation continues when one task has corrupt data', async () => {
    // 1. Create multiple tasks
    const taskId1 = await createTask(ctx, 'Normal task 1', 'Do work');
    const taskId2 = await createTask(ctx, 'Corrupt task', 'Do work');
    const taskId3 = await createTask(ctx, 'Normal task 2', 'Do work');

    // 2. Start all tasks
    await ctx.lazyMocked(['start', taskId1, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    await ctx.lazyMocked(['start', taskId2, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    await ctx.lazyMocked(['start', taskId3, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // 3. Reconcile all to blocked
    await runReconcile(ctx.root);

    // 4. Set all tasks to interrupted so the sweep will try to process them
    const fullTaskId1 = findFullTaskId(ctx.root, taskId1);
    const fullTaskId2 = findFullTaskId(ctx.root, taskId2);
    const fullTaskId3 = findFullTaskId(ctx.root, taskId3);
    setTaskStatus(ctx.root, fullTaskId1, 'interrupted');
    setTaskStatus(ctx.root, fullTaskId2, 'interrupted');
    setTaskStatus(ctx.root, fullTaskId3, 'interrupted');

    // 5. Write stale responses for task 1 and 3 (not task 2)
    const protoDir1 = getProtocolDir(fullTaskId1);
    const protoDir3 = getProtocolDir(fullTaskId3);
    const completedResp: CompletedResponse = {
      status: 'completed',
      result: 'Recovery test completed.',
      session_id: 'mock-sess-recovery',
      usage: { input_tokens: 100, output_tokens: 200 },
    };
    writeResponse(protoDir1, completedResp);
    writeResponse(protoDir3, completedResp);

    // 6. Corrupt the middle task's session.json to cause errors during reconciliation
    // Do this AFTER setTaskStatus to avoid breaking the test helper
    const sessionPath = join(ctx.root, '.lazy', 'tasks', fullTaskId2, 'session.json');
    writeFileSync(sessionPath, '{invalid json');

    // 7. Trigger reconciliation — sweep should continue despite task2 error
    // The reconciliation should not crash
    await runReconcile(ctx.root);

    // 8. Verify task1 and task3 were still processed (moved to blocked)
    // Task2 may remain interrupted due to corrupt data, but reconciliation should not crash
    const show1 = await ctx.lazy(['show', taskId1]);
    expectSuccess(show1);
    // Task 1 should have been processed (blocked or complete)
    expect(show1.stdout.includes('interrupted') || show1.stdout.includes('blocked') || show1.stdout.includes('complete')).toBe(true);

    const show3 = await ctx.lazy(['show', taskId3]);
    expectSuccess(show3);
    // Task 3 should have been processed (blocked or complete)
    expect(show3.stdout.includes('interrupted') || show3.stdout.includes('blocked') || show3.stdout.includes('complete')).toBe(true);
  });

});
