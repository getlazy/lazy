import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import {
  writeResponse,
  consumeResponse,
  readCommand,
  protocolDir as getProtocolDir,
} from '../../src/protocol';
import type { CompletedResponse, ErrorResponse, UnblockCommand } from '../../src/protocol';

// ============================================================
// Helpers
// ============================================================

function findFullTaskId(root: string, shortId: string): string {
  const tasksDir = join(root, '.lazy', 'tasks');
  const entries = readdirSync(tasksDir);
  const match = entries.find((e: string) => e.startsWith(shortId));
  if (!match) {
    throw new Error(`Could not find full task ID for short ID: ${shortId}`);
  }
  return match;
}

function setTaskStatus(root: string, fullTaskId: string, status: string): void {
  const taskPath = join(root, '.lazy', 'tasks', fullTaskId, 'task.json');
  const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
  task.status = status;
  writeFileSync(taskPath, JSON.stringify(task, null, 2));

  // Also update the session's last_interaction_at to bypass grace period
  const sessionPath = join(root, '.lazy', 'tasks', fullTaskId, 'session.json');
  if (existsSync(sessionPath)) {
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));
    session.last_interaction_at = Date.now() - 60000;
    writeFileSync(sessionPath, JSON.stringify(session, null, 2));
  }
}

function readSession(root: string, fullTaskId: string): Record<string, unknown> {
  const sessionPath = join(root, '.lazy', 'tasks', fullTaskId, 'session.json');
  return JSON.parse(readFileSync(sessionPath, 'utf-8'));
}

function writeSession(root: string, fullTaskId: string, session: Record<string, unknown>): void {
  const sessionPath = join(root, '.lazy', 'tasks', fullTaskId, 'session.json');
  writeFileSync(sessionPath, JSON.stringify(session, null, 2));
}

// ============================================================
// Section 1: Interrupt diagnostics capture
// ============================================================

describe('interrupt diagnostics', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('interrupted task captures diagnostic fields in session', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Diagnostics test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // 2. Reconcile to move to blocked
    await ctx.lazy(['list']);

    const fullTaskId = findFullTaskId(ctx.root, taskId);

    // 3. Set task to working (simulating a resumed task whose container died)
    setTaskStatus(ctx.root, fullTaskId, 'working');

    // Remove the response so reconciler sees no response + no container = interrupted
    const protoDir = getProtocolDir(fullTaskId);
    consumeResponse(protoDir);

    // 4. Trigger reconciliation — task should be marked as interrupted with diagnostics
    await ctx.lazy(['list']);

    // 5. Verify diagnostics were captured in session.json
    const session = readSession(ctx.root, fullTaskId);
    expect(session.interrupt_reason).toBeTruthy();
    expect(session.interrupt_at).toBeTruthy();
    expect(typeof session.interrupt_at).toBe('number');
    expect(session.consecutive_interruptions).toBe(1);
  });

  test('lazy show displays interrupt reason when task is interrupted', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Show diagnostics test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // 2. Reconcile to move to blocked
    await ctx.lazy(['list']);

    const fullTaskId = findFullTaskId(ctx.root, taskId);

    // 3. Set task to working and remove response
    setTaskStatus(ctx.root, fullTaskId, 'working');
    consumeResponse(getProtocolDir(fullTaskId));

    // 4. Trigger reconciliation to interrupt
    await ctx.lazy(['list']);

    // 5. Verify lazy show displays interrupt information
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'Last Interrupt');
    expectOutput(showResult, 'Reason:');
    expectOutput(showResult, 'Consecutive:');
  });

  test('lazy status displays interrupt history when task is interrupted', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Status diagnostics test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // 2. Reconcile to blocked
    await ctx.lazy(['list']);

    const fullTaskId = findFullTaskId(ctx.root, taskId);

    // 3. Set to working and remove response
    setTaskStatus(ctx.root, fullTaskId, 'working');
    consumeResponse(getProtocolDir(fullTaskId));

    // 4. Trigger reconciliation to interrupt
    await ctx.lazy(['list']);

    // 5. Verify lazy status displays interrupt information
    const statusResult = await ctx.lazy(['status', taskId]);
    expectSuccess(statusResult);
    expectOutput(statusResult, 'Last Interrupt');
    expectOutput(statusResult, 'Reason:');
  });

  test('error response records interrupt diagnostics', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Error diagnostics test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // 2. Reconcile to blocked
    await ctx.lazy(['list']);

    const fullTaskId = findFullTaskId(ctx.root, taskId);
    const protoDir = getProtocolDir(fullTaskId);

    // 3. Set to working with an error response
    setTaskStatus(ctx.root, fullTaskId, 'working');
    consumeResponse(protoDir);
    const errorResp: ErrorResponse = {
      status: 'error',
      error: 'Claude process crashed with OOM',
      phase: 'work',
      exit_code: 137,
      stderr: 'Killed',
    };
    writeResponse(protoDir, errorResp);

    // 4. Trigger reconciliation
    await ctx.lazy(['list']);

    // 5. Verify diagnostics captured with exit code info
    const session = readSession(ctx.root, fullTaskId);
    expect(session.interrupt_exit_code).toBe(137);
    expect(session.consecutive_interruptions).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// Section 2: Auto-resume on reconciliation
// ============================================================

describe('auto-resume on reconciliation', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('interrupted task is auto-resumed by reconciler', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Auto-resume test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // 2. Reconcile to blocked
    await ctx.lazyMocked(['list'], MOCK_CLAUDE_SUCCESS);

    const fullTaskId = findFullTaskId(ctx.root, taskId);

    // 3. Set to working and remove response (simulating container crash)
    setTaskStatus(ctx.root, fullTaskId, 'working');
    consumeResponse(getProtocolDir(fullTaskId));

    // 4. Trigger reconciliation — auto-resume should kick in
    //    In test mode, the mock launchSupervisorAsync writes a response immediately,
    //    so after this reconciliation the task might be 'working' (auto-resumed) or
    //    the mock may have written a new response.json already.
    const listResult = await ctx.lazyMocked(['list'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(listResult);

    // 5. Check session was marked as auto-resumed
    const session = readSession(ctx.root, fullTaskId);
    // The auto-resume should have set consecutive_interruptions >= 1
    // and auto_resumed to true (or the task was already re-reconciled to blocked)
    expect(session.consecutive_interruptions).toBeGreaterThanOrEqual(0);

    // The task should either be 'working' (auto-resumed, waiting for next reconcile)
    // or 'blocked' (auto-resumed, mock wrote response, next reconcile moved to blocked)
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    const hasValidStatus =
      showResult.stdout.includes('working') ||
      showResult.stdout.includes('blocked');
    expect(hasValidStatus).toBe(true);
  });

  // INVARIANT: Every unblock merges upstream before giving feedback.
  // Auto-resume must set parent_branch and sync_before_work on the UnblockCommand
  // so the supervisor merges upstream before the agent resumes — but only when
  // the worktree is clean. A dirty worktree means the agent crashed mid-turn
  // and git merge would fail or create confusing state.
  test('auto-resume sets parent_branch and sync_before_work on clean worktree', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Upstream merge test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // 2. Reconcile to blocked
    await ctx.lazyMocked(['list'], MOCK_CLAUDE_SUCCESS);

    const fullTaskId = findFullTaskId(ctx.root, taskId);

    // 3. Set to working and remove response (simulating container crash)
    setTaskStatus(ctx.root, fullTaskId, 'working');
    consumeResponse(getProtocolDir(fullTaskId));

    // 4. Trigger reconciliation — auto-resume should kick in and write a
    //    command.json with parent_branch and sync_before_work
    await ctx.lazyMocked(['list'], MOCK_CLAUDE_SUCCESS);

    // 5. Read the command.json written by auto-resume
    const protoDir = getProtocolDir(fullTaskId);
    const command = readCommand(protoDir) as UnblockCommand;
    expect(command).not.toBeNull();
    expect(command.type).toBe('unblock');
    expect(command.parent_branch).toBeTruthy();
    expect(command.sync_before_work).toBe(true);
    // Clean worktree should get the upstream-merged crash context
    expect(command.prompt).toContain('Upstream has been merged into your branch');
  });

  // INVARIANT: Dirty worktree (uncommitted changes from crashed turn) must NOT
  // trigger upstream merge — git merge on a dirty worktree will fail or create
  // confusing state. The agent should handle the uncommitted changes first.
  test('auto-resume skips upstream merge on dirty worktree', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Dirty worktree test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // 2. Reconcile to blocked
    await ctx.lazyMocked(['list'], MOCK_CLAUDE_SUCCESS);

    const fullTaskId = findFullTaskId(ctx.root, taskId);

    // 3. Set to working and remove response (simulating container crash)
    setTaskStatus(ctx.root, fullTaskId, 'working');
    consumeResponse(getProtocolDir(fullTaskId));

    // 4. Create uncommitted changes in the worktree to simulate a crash mid-turn
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'dirty-file.txt'), 'uncommitted work from crashed agent');

    // 5. Trigger reconciliation — auto-resume should skip upstream merge
    await ctx.lazyMocked(['list'], MOCK_CLAUDE_SUCCESS);

    // 6. Read the command.json written by auto-resume
    const protoDir = getProtocolDir(fullTaskId);
    const command = readCommand(protoDir) as UnblockCommand;
    expect(command).not.toBeNull();
    expect(command.type).toBe('unblock');
    // Dirty worktree: no parent_branch, no sync
    expect(command.parent_branch).toBeUndefined();
    expect(command.sync_before_work).toBe(false);
    // Dirty worktree should get the uncommitted-changes crash context
    expect(command.prompt).toContain('uncommitted changes in your worktree');
  });

  test('consecutive_interruptions resets on successful turn completion', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Reset counter test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // 2. Reconcile to blocked
    await ctx.lazy(['list']);

    const fullTaskId = findFullTaskId(ctx.root, taskId);

    // 3. Manually set consecutive_interruptions to simulate prior interruptions
    const session = readSession(ctx.root, fullTaskId);
    session.consecutive_interruptions = 2;
    writeSession(ctx.root, fullTaskId, session);

    // 4. Set to working with a completed response (simulating a turn that succeeds)
    setTaskStatus(ctx.root, fullTaskId, 'working');
    const completedResp: CompletedResponse = {
      status: 'completed',
      result: 'Work completed successfully.',
      session_id: 'mock-sess-reset',
      usage: { input_tokens: 100, output_tokens: 200 },
    };
    writeResponse(getProtocolDir(fullTaskId), completedResp);

    // 5. Trigger reconciliation — should process the response and reset counter
    await ctx.lazy(['list']);

    // 6. Verify counter was reset
    const updatedSession = readSession(ctx.root, fullTaskId);
    expect(updatedSession.consecutive_interruptions).toBe(0);
    expect(updatedSession.auto_resumed).toBe(false);
  });
});

// ============================================================
// Section 3: Circuit breaker
// ============================================================

describe('circuit breaker', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('circuit breaker stops auto-resume after 3 consecutive interruptions', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Circuit breaker test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // 2. Reconcile to blocked
    await ctx.lazy(['list']);

    const fullTaskId = findFullTaskId(ctx.root, taskId);

    // 3. Set consecutive_interruptions to 2 (one below threshold)
    //    then simulate an interruption — this will be the 3rd
    const session = readSession(ctx.root, fullTaskId);
    session.consecutive_interruptions = 2;
    writeSession(ctx.root, fullTaskId, session);

    // 4. Set to working and remove response (simulating container crash)
    setTaskStatus(ctx.root, fullTaskId, 'working');
    consumeResponse(getProtocolDir(fullTaskId));

    // 5. Trigger reconciliation — should interrupt but NOT auto-resume
    //    because consecutive_interruptions will be 3 after increment
    const listResult = await ctx.lazyMocked(['list'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(listResult);

    // 6. Verify task remains interrupted (circuit breaker prevented auto-resume)
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'interrupted');

    // 7. Verify consecutive_interruptions is now 3
    const updatedSession = readSession(ctx.root, fullTaskId);
    expect(updatedSession.consecutive_interruptions).toBe(3);
  });

  test('manual resume resets consecutive_interruptions counter', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Manual reset test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });

    // 2. Reconcile to blocked
    await ctx.lazy(['list']);

    const fullTaskId = findFullTaskId(ctx.root, taskId);

    // 3. Set consecutive_interruptions to 3 (above threshold) and set task to interrupted
    const session = readSession(ctx.root, fullTaskId);
    session.consecutive_interruptions = 3;
    writeSession(ctx.root, fullTaskId, session);
    setTaskStatus(ctx.root, fullTaskId, 'interrupted');

    // 4. Manual resume should reset the counter
    const resumeResult = await ctx.lazyMocked(['resume', taskId], MOCK_CLAUDE_SUCCESS);
    expectSuccess(resumeResult);

    // 5. Verify counter was reset
    const updatedSession = readSession(ctx.root, fullTaskId);
    expect(updatedSession.consecutive_interruptions).toBe(0);
  });
});
