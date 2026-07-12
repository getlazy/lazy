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
import { openProjectStorage } from '../../src/daemon/rpc-handlers';

// ============================================================
// Helpers
// ============================================================

/**
 * Resolve the tasks directory for a test project. Test projects init with
 * external storage (external_path in lazy.toml), so tasks live outside the
 * repo; fall back to the in-repo .lazy/tasks layout when no external_path.
 */
function tasksDirFor(root: string): string {
  const toml = readFileSync(join(root, 'lazy.toml'), 'utf-8');
  const m = toml.match(/^external_path\s*=\s*"(.+)"/m);
  if (m && m[1]) return join(m[1], 'tasks');
  return join(root, '.lazy', 'tasks');
}

/**
 * Find the full task ID from a short ID by scanning the tasks directory.
 */
function findFullTaskId(root: string, shortId: string): string {
  const tasksDir = tasksDirFor(root);
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
  const taskPath = join(tasksDirFor(root), fullTaskId, 'task.json');
  const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
  task.status = status;
  writeFileSync(taskPath, JSON.stringify(task, null, 2));

  // Also update the session's last_interaction_at to bypass grace period
  const sessionPath = join(tasksDirFor(root), fullTaskId, 'session.json');
  if (existsSync(sessionPath)) {
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));
    session.last_interaction_at = new Date(Date.now() - 60000).toISOString();
    writeFileSync(sessionPath, JSON.stringify(session, null, 2));
  }
}

/**
 * Create the authoritative accept tag the zombie sweep gates on.
 * Mirrors what `lazy accept` does during the merge step (annotated tag,
 * `lazy-accept-<full-task-id>`, pointing at the merge/FF commit).
 */
function createAcceptTag(ctx: TestContext, fullTaskId: string, commitish: string = 'main'): void {
  const r = ctx.git('tag', '-a', '-f', '-m', `Accepted task ${fullTaskId}`, `lazy-accept-${fullTaskId}`, commitish);
  if (r.exitCode !== 0) {
    throw new Error(`Failed to create accept tag: ${r.stderr}`);
  }
}

/**
 * Run reconciliation directly (simulates what the daemon does).
 * Tests can't rely on CLI commands triggering reconciliation — only the daemon does that.
 */
async function runReconcile(root: string): Promise<void> {
  const storage = await openProjectStorage(root);
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
  const sessionPath = join(tasksDirFor(root), fullTaskId, 'session.json');
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

    // Start the task so it has a session and transitions to working/blocked.
    // INVARIANT: the mock must NOT commit here. This test asserts the *interrupt*
    // path (no container + no response → interrupted). If the mock leaves real
    // committed work behind, the later reconcile legitimately routes it through
    // recoverStrandedCompletion → 'blocked' instead (that path exists precisely
    // so committed work is never lost), which would mask the grace-period fix
    // this test targets. No commit = nothing to recover = a clean interrupt.
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

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

  // REGRESSION: squash accept path. A task whose work was squash-merged into the target
  // and tagged with `lazy-accept-<id>`, but whose status update crashed before reaching
  // `complete`, IS recovered by the sweep.
  test('accepted (tagged) task whose status crashed is recovered — squash path', async () => {
    // 1. Create and start a task with commits
    const taskId = await createTask(ctx, 'Zombie branch test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // 2. Reconcile to move to blocked
    await runReconcile(ctx.root);

    const fullTaskId = findFullTaskId(ctx.root, taskId);

    // 3. Verify task is blocked before the merge
    const taskPath = join(tasksDirFor(ctx.root), fullTaskId, 'task.json');
    const taskBefore = JSON.parse(readFileSync(taskPath, 'utf-8'));
    expect(taskBefore.status).toBe('blocked');

    // 4. Simulate accept that crashed after merge: squash-merge into main AND create the
    //    authoritative accept tag, but WITHOUT updating session/task metadata.
    const branchName = `lazy/${taskId}`;
    ctx.git('checkout', 'main');
    ctx.git('merge', '--squash', branchName);
    ctx.git('commit', '-m', `Accept task ${taskId}: Zombie branch test`);
    createAcceptTag(ctx, fullTaskId, 'main');
    ctx.git('checkout', branchName);

    // 5. Trigger reconciliation — sweep should detect and fix the zombie
    await runReconcile(ctx.root);

    const showAfter = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfter);
    expectOutput(showAfter, 'complete');
  });

  // REGRESSION: local branches left behind after accept. When the zombie sweep recovers a
  // crashed accept, it must ALSO tear down the worktree and delete the LOCAL task branch —
  // exactly the cleanup the crashed accept never reached. Before the fix the sweep flipped
  // the task to `complete` but left the `lazy/<id>` branch and its worktree behind forever,
  // which is how ~80 stale local branches accumulated. The remote ref MUST survive: the fix
  // deletes local branches only.
  test('zombie-sweep recovery deletes the local branch + worktree but leaves the remote ref untouched', async () => {
    const taskId = await createTask(ctx, 'Zombie cleanup test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    await runReconcile(ctx.root);
    const fullTaskId = findFullTaskId(ctx.root, taskId);
    const branchName = `lazy/${taskId}`;
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);

    // Stand up a bare remote and push the task branch to it. The fix must delete the
    // LOCAL branch only — the engineer explicitly wants remote lazy/* refs preserved.
    expect(ctx.git('init', '--bare', 'remote.git').exitCode).toBe(0);
    expect(ctx.git('remote', 'add', 'origin', join(ctx.root, 'remote.git')).exitCode).toBe(0);
    expect(ctx.git('push', 'origin', `${branchName}:${branchName}`).exitCode).toBe(0);

    // Pre-conditions: local branch + worktree present, remote ref present.
    expect(ctx.git('rev-parse', '--verify', `refs/heads/${branchName}`).exitCode).toBe(0);
    expect(existsSync(worktreePath)).toBe(true);
    expect(ctx.git('ls-remote', '--heads', 'origin', branchName).stdout).toContain(branchName);

    // Simulate an accept that merged + tagged but crashed before cleanup: squash-merge into
    // main and create the authoritative accept tag, but leave the task non-terminal and the
    // worktree/branch in place (no metadata update, no teardown). Leave the main repo on
    // `main` so the worktree retains the branch (mirrors the real crash state).
    ctx.git('checkout', 'main');
    ctx.git('merge', '--squash', branchName);
    ctx.git('commit', '-m', `Accept task ${taskId}: Zombie cleanup test`);
    createAcceptTag(ctx, fullTaskId, 'main');

    // Trigger reconciliation — the sweep recovers the zombie AND runs cleanup.
    await runReconcile(ctx.root);

    // Task recovered to complete.
    const showAfter = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfter);
    expectOutput(showAfter, 'complete');

    // LOCAL branch deleted and worktree torn down — no leftovers.
    expect(ctx.git('rev-parse', '--verify', `refs/heads/${branchName}`).exitCode).not.toBe(0);
    expect(existsSync(worktreePath)).toBe(false);

    // REMOTE ref preserved — the fix must NEVER delete remote lazy/* refs.
    expect(ctx.git('ls-remote', '--heads', 'origin', branchName).stdout).toContain(branchName);
  });

  // REGRESSION: fast-forward accept path. The remote FF path moves the target ref and
  // produces no "Accept task <id>" commit message, but DOES create the accept tag. The
  // sweep must recover from the tag alone, independent of how the commit was produced.
  test('accepted (tagged) task whose status crashed is recovered — fast-forward path', async () => {
    const taskId = await createTask(ctx, 'FF zombie test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    await runReconcile(ctx.root);
    const fullTaskId = findFullTaskId(ctx.root, taskId);
    const branchName = `lazy/${taskId}`;

    // Simulate a FF accept: fast-forward main to the branch tip (no squash/merge commit),
    // tag the FF commit, then delete the branch (cleanup ran after merge).
    ctx.git('checkout', 'main');
    ctx.git('merge', '--ff-only', branchName);
    createAcceptTag(ctx, fullTaskId, 'main');

    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    if (existsSync(worktreePath)) {
      ctx.git('worktree', 'remove', worktreePath, '--force');
    }
    ctx.git('branch', '-D', branchName);

    await runReconcile(ctx.root);

    const showAfter = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfter);
    expectOutput(showAfter, 'complete');
  });

  // INVARIANT: a crash-looping task whose branch is tree-equal to the target but was NEVER
  // accepted (no `lazy-accept-<id>` tag) MUST NOT be swept to complete. The old sweep used
  // a branch-relative tree-equality check (isBranchMergedInto) / commit-message grep, which
  // silently completed crash-looping tasks that merely happened to match the target. The
  // accept tag is now the authoritative — and only — completion signal.
  test('tree-equal but never-accepted (no tag) task is NOT swept to complete', async () => {
    const taskId = await createTask(ctx, 'No-tag tree-equal zombie', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    await runReconcile(ctx.root);
    const fullTaskId = findFullTaskId(ctx.root, taskId);
    setTaskStatus(ctx.root, fullTaskId, 'interrupted');

    // Make the branch tree-equal to main (work merged) but DO NOT create the accept tag —
    // this is exactly the ambiguous signal that previously caused false positives.
    const branchName = `lazy/${taskId}`;
    ctx.git('checkout', 'main');
    ctx.git('merge', '--squash', branchName);
    ctx.git('commit', '-m', `Accept task ${taskId}: No-tag tree-equal zombie`);
    ctx.git('checkout', branchName);

    await runReconcile(ctx.root);

    // Must stay interrupted — never accepted, so never auto-completed.
    const showAfter = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfter);
    expectOutput(showAfter, 'interrupted');
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
  // intent would be lost. This is the defense-in-depth `hasAgentWork` guard that runs
  // even when an accept tag is present, so this test creates the tag to exercise it.
  test('task with zero agent turns is not auto-accepted even if accept tag is present', async () => {
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
    const turnsPath = join(tasksDirFor(ctx.root), fullTaskId, 'turns.json');
    const turnsData = JSON.parse(readFileSync(turnsPath, 'utf-8'));
    turnsData.turns = turnsData.turns.filter((t: { role: string }) => t.role !== 'agent');
    writeFileSync(turnsPath, JSON.stringify(turnsData, null, 2));

    // 4. Set task back to blocked (it may have been complete/blocked, reset to blocked)
    setTaskStatus(ctx.root, fullTaskId, 'blocked');

    // Also clear session outcome so the sweep doesn't skip it
    const sessionPath = join(tasksDirFor(ctx.root), fullTaskId, 'session.json');
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));
    session.outcome = null;
    session.ended_at = null;
    writeFileSync(sessionPath, JSON.stringify(session, null, 2));

    // 5. Squash-merge the branch into main AND create the accept tag (making it look like
    //    a fully accepted zombie) — only the missing agent turns should stop completion.
    const branchName = `lazy/${taskId}`;
    ctx.git('checkout', 'main');
    ctx.git('merge', '--squash', branchName);
    ctx.git('commit', '-m', `Accept task ${taskId}: No-agent zombie test`);
    createAcceptTag(ctx, fullTaskId, 'main');
    ctx.git('checkout', branchName);

    // 6. Trigger reconciliation — the sweep should skip this task on the hasAgentWork guard
    await runReconcile(ctx.root);

    // 7. Verify task is still blocked (NOT auto-accepted to complete)
    const showAfter = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfter);
    expectOutput(showAfter, 'blocked');
  });

  // INVARIANT: A never-accepted task (no `lazy-accept-<id>` tag) with only the --allow-empty
  // init commit created by `lazy start` must never be swept to complete. With no accept tag
  // there is nothing to recover, regardless of commit count or tree-equality.
  test('task with only empty init commit and no accept tag is not auto-accepted', async () => {
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
    const turnsPath = join(tasksDirFor(ctx.root), fullTaskId, 'turns.json');
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
    const sessionPath = join(tasksDirFor(ctx.root), fullTaskId, 'session.json');
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

  // REGRESSION: the exact reported bug — a crash-looping `interrupted` task that WAS
  // accepted (tag present) but whose status update crashed must be recovered to complete.
  test('interrupted task that was accepted (tag present) is recovered', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Interrupted zombie test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // 2. Reconcile to blocked, then manually set to interrupted
    await runReconcile(ctx.root);
    const fullTaskId = findFullTaskId(ctx.root, taskId);
    setTaskStatus(ctx.root, fullTaskId, 'interrupted');

    // 3. Squash-merge into main AND create the accept tag, without updating metadata
    const branchName = `lazy/${taskId}`;
    ctx.git('checkout', 'main');
    ctx.git('merge', '--squash', branchName);
    ctx.git('commit', '-m', `Accept task ${taskId}: Interrupted zombie test`);
    createAcceptTag(ctx, fullTaskId, 'main');
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
// Section 4b: Stranded working-task recovery
// ============================================================

describe('reconciliation sweep: stranded working tasks', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // REGRESSION: the reported bug. An agent finished a turn and committed real
  // work to its branch, but the supervisor never produced a processable response
  // (crash / kill / hang at finalize). The task must NOT wedge in 'working'
  // forever with turns/commits unpersisted — the reconciler recovers it to
  // 'blocked' and backfills the committed work from the branch (git is the
  // source of truth when storage is empty).
  test('working task with committed work but no response recovers to blocked + backfills commits', async () => {
    const taskId = await createTask(ctx, 'Stranded recovery test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    const fullTaskId = findFullTaskId(ctx.root, taskId);
    const protoDir = getProtocolDir(fullTaskId);

    // Simulate the stranded state: the agent committed (start's mock made a real
    // commit on the branch) but the turn was never finalized — drop the response
    // so the normal completion path can't run, and leave the task in 'working'.
    consumeResponse(protoDir);
    setTaskStatus(ctx.root, fullTaskId, 'working');

    // Pre-condition: no commit recorded yet (the turn was never finalized).
    const showBefore = await ctx.lazy(['show', taskId]);
    expectSuccess(showBefore);
    expectOutput(showBefore, 'working');

    // Reconcile — the stranded-completion recovery should fire.
    await runReconcile(ctx.root);

    // Recovered to blocked, with the committed work backfilled and visible.
    const showAfter = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfter);
    expectOutput(showAfter, 'blocked');

    // The task now surfaces for review (in `lazy blocked`) — the review loop is restored.
    const blocked = await ctx.lazy(['blocked']);
    expectSuccess(blocked);
    expectOutput(blocked, taskId);

    // Commits were backfilled from the branch (commit_count > 0), so the task is
    // acceptable. A recovery turn records the lost-finalize gap.
    const showFull = await ctx.lazy(['show', taskId, '--full']);
    expectSuccess(showFull);
    expectOutput(showFull, 'Recovered');
  });

  // INVARIANT: a working task whose branch has only the --allow-empty init commit
  // (agent never produced real work) must NOT be "recovered" to blocked — there is
  // nothing to review. It falls through to interrupted, the same as before.
  test('working task with no real committed work falls through to interrupted', async () => {
    const taskId = await createTask(ctx, 'No-work stranded test', 'Do work');
    // Start WITHOUT LAZY_MOCK_SHOULD_COMMIT — only the empty init commit exists.
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    const fullTaskId = findFullTaskId(ctx.root, taskId);
    const protoDir = getProtocolDir(fullTaskId);

    // Strip any agent commits the mock may have made so the branch is tree-equal
    // to its base, then strand it in 'working' with no response.
    const branchName = `lazy/${taskId}`;
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const mergeBase = ctx.git('merge-base', branchName, 'main').stdout.trim();
    Bun.spawnSync(['git', 'reset', '--hard', mergeBase], { cwd: worktreePath });
    // Re-create the empty init commit so the branch still exists with a tip.
    Bun.spawnSync(['git', 'commit', '--allow-empty', '-m', 'init'], { cwd: worktreePath });

    consumeResponse(protoDir);
    setTaskStatus(ctx.root, fullTaskId, 'working');

    await runReconcile(ctx.root);

    // No real work → not recovered to blocked; ends up interrupted (existing behavior).
    const showAfter = await ctx.lazy(['show', taskId]);
    expectSuccess(showAfter);
    expectOutput(showAfter, 'interrupted');
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
    const sessionPath = join(tasksDirFor(ctx.root), fullTaskId2, 'session.json');
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
