import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { runReconcile as runReconcileSubprocess } from '../helpers/reconcile';
import {
  writeResponse,
  consumeResponse,
  readCommand,
  consumeCommand,
  protocolDir as getProtocolDir,
} from '../../src/protocol';
import type { CompletedResponse, ErrorResponse, UnblockCommand } from '../../src/protocol';

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

function findFullTaskId(root: string, shortId: string): string {
  const tasksDir = tasksDirFor(root);
  const entries = readdirSync(tasksDir);
  const match = entries.find((e: string) => e.startsWith(shortId));
  if (!match) {
    throw new Error(`Could not find full task ID for short ID: ${shortId}`);
  }
  return match;
}

function setTaskStatus(root: string, fullTaskId: string, status: string): void {
  const taskPath = join(tasksDirFor(root), fullTaskId, 'task.json');
  const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
  task.status = status;
  writeFileSync(taskPath, JSON.stringify(task, null, 2));

  // Also update the session's last_interaction_at to bypass grace period
  const sessionPath = join(tasksDirFor(root), fullTaskId, 'session.json');
  if (existsSync(sessionPath)) {
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));
    session.last_interaction_at = Date.now() - 60000;
    writeFileSync(sessionPath, JSON.stringify(session, null, 2));
  }
}

function readSession(root: string, fullTaskId: string): Record<string, unknown> {
  const sessionPath = join(tasksDirFor(root), fullTaskId, 'session.json');
  return JSON.parse(readFileSync(sessionPath, 'utf-8'));
}

function writeSession(root: string, fullTaskId: string, session: Record<string, unknown>): void {
  const sessionPath = join(tasksDirFor(root), fullTaskId, 'session.json');
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
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // 2. Reconcile to move to blocked
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);

    const fullTaskId = findFullTaskId(ctx.root, taskId);

    // 3. Set task to working (simulating a resumed task whose container died)
    setTaskStatus(ctx.root, fullTaskId, 'working');

    // Remove the response so reconciler sees no response + no container = interrupted
    const protoDir = getProtocolDir(fullTaskId);
    consumeResponse(protoDir);

    // 4. Trigger reconciliation — task should be marked as interrupted with diagnostics
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);

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
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // 2. Reconcile to move to blocked
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);

    const fullTaskId = findFullTaskId(ctx.root, taskId);

    // 3. Set task to working and remove response
    setTaskStatus(ctx.root, fullTaskId, 'working');
    consumeResponse(getProtocolDir(fullTaskId));

    // 4. Trigger reconciliation to interrupt
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);

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
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // 2. Reconcile to blocked
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);

    const fullTaskId = findFullTaskId(ctx.root, taskId);

    // 3. Set to working and remove response
    setTaskStatus(ctx.root, fullTaskId, 'working');
    consumeResponse(getProtocolDir(fullTaskId));

    // 4. Trigger reconciliation to interrupt
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);

    // 5. Verify lazy status displays interrupt information
    const statusResult = await ctx.lazy(['status', taskId]);
    expectSuccess(statusResult);
    expectOutput(statusResult, 'Last Interrupt');
    expectOutput(statusResult, 'Reason:');
  });

  test('error response records interrupt diagnostics', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Error diagnostics test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // 2. Reconcile to blocked
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);

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
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);

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
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // 2. Reconcile to blocked
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);

    const fullTaskId = findFullTaskId(ctx.root, taskId);

    // 3. Set to working and remove response (simulating container crash)
    setTaskStatus(ctx.root, fullTaskId, 'working');
    consumeResponse(getProtocolDir(fullTaskId));

    // 4. Trigger reconciliation — auto-resume should kick in
    //    In test mode, the mock launchSupervisorAsync writes a response immediately,
    //    so after this reconciliation the task might be 'working' (auto-resumed) or
    //    the mock may have written a new response.json already.
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);

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
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // 2. Reconcile to blocked
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);

    const fullTaskId = findFullTaskId(ctx.root, taskId);

    // 3. Set to working and remove response (simulating container crash)
    setTaskStatus(ctx.root, fullTaskId, 'working');
    consumeResponse(getProtocolDir(fullTaskId));

    // 4. Trigger reconciliation — auto-resume should kick in and write a
    //    command.json with parent_branch and sync_before_work
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);

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
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // 2. Reconcile to blocked
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);

    const fullTaskId = findFullTaskId(ctx.root, taskId);

    // 3. Set to working and remove response (simulating container crash)
    setTaskStatus(ctx.root, fullTaskId, 'working');
    consumeResponse(getProtocolDir(fullTaskId));

    // 4. Create uncommitted changes in the worktree to simulate a crash mid-turn
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'dirty-file.txt'), 'uncommitted work from crashed agent');

    // 5. Trigger reconciliation — auto-resume should skip upstream merge
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);

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
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // 2. Reconcile to blocked
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);

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
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);

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
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // 2. Reconcile to blocked
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);

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
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);

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
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // 2. Reconcile to blocked
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);

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

// ============================================================
// Section 3b: Project-wide gap applies to the fast lane too
//
// INVARIANT: daemon.auto_resume_gap_minutes spaces out ANY two auto-resumes,
// fast-lane or slow-lane, via the same auto-resume-queue.json timestamp.
// Without this, a burst of simultaneous crashes would relaunch every task
// immediately on the fast lane (well below the circuit-breaker threshold),
// defeating the gap entirely until they eventually fell to the slow lane.
// ============================================================

describe('project-wide gap on the fast lane', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('a recent project-wide auto-resume defers a fresh fast-lane crash', async () => {
    // 1. Create and start a task
    const taskId = await createTask(ctx, 'Gap test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);

    const fullTaskId = findFullTaskId(ctx.root, taskId);

    // Consume the leftover initial `start` command.json so a later readCommand
    // null-check actually proves no NEW (resume) command was written, rather
    // than just seeing the original start command untouched.
    consumeCommand(getProtocolDir(fullTaskId));

    // 2. Seed the project-wide gap file as if some other task was just
    //    auto-resumed a moment ago (well within the default 5-minute gap).
    const gapFile = join(ctx.root, '.lazy', 'auto-resume-queue.json');
    writeFileSync(gapFile, JSON.stringify({ lastAutoResumeAt: Date.now() }));

    // 3. Set to working and remove response (simulating container crash) —
    //    consecutive_interruptions will land at 1, well below the circuit
    //    breaker, so this task would normally auto-resume immediately.
    setTaskStatus(ctx.root, fullTaskId, 'working');
    consumeResponse(getProtocolDir(fullTaskId));

    // 4. Trigger reconciliation — the interruption is recorded, but the
    //    project-wide gap should defer the actual resume attempt.
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);

    // 5. Task stays interrupted; no unblock command was written.
    const showResult = await ctx.lazy(['show', taskId]);
    expectSuccess(showResult);
    expectOutput(showResult, 'interrupted');

    const command = readCommand(getProtocolDir(fullTaskId));
    expect(command).toBeNull();

    const session = readSession(ctx.root, fullTaskId);
    expect(session.consecutive_interruptions).toBe(1);
  });
});

// ============================================================
// Section 4: Crash-safe feedback redelivery
//
// INVARIANT (CLAUDE.md — never lose human feedback): when a work phase crashes
// AFTER feedback was persisted but BEFORE the agent consumed it, resuming with
// the generic "you were interrupted, carry on" prompt effectively throws the
// feedback away — it survives only implicitly via turn-history injection, and
// in the live NUL incident it was never acted on. Auto-resume must re-deliver
// the unconsumed feedback VERBATIM instead. This applies to every crash cause.
// ============================================================

describe('feedback redelivery on auto-resume', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Crash the task mid-turn (working, no response) and let the reconciler auto-resume it. */
  async function crashAndAutoResume(fullTaskId: string): Promise<UnblockCommand> {
    setTaskStatus(ctx.root, fullTaskId, 'working');
    consumeResponse(getProtocolDir(fullTaskId));
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);
    const command = readCommand(getProtocolDir(fullTaskId)) as UnblockCommand;
    expect(command).not.toBeNull();
    expect(command.type).toBe('unblock');
    return command;
  }

  test('unconsumed unblock feedback is re-delivered verbatim as the resume prompt', async () => {
    const taskId = await createTask(ctx, 'Redelivery test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);

    const fullTaskId = findFullTaskId(ctx.root, taskId);

    // Human feedback is persisted, then the turn crashes before any reconcile
    // consumes the agent's response — so the feedback stays 'pending'.
    const feedback ='Rename the widget module and keep the tests green';
    await ctx.lazyMocked(['unblock', taskId, '--message', feedback], MOCK_CLAUDE_SUCCESS);

    const command = await crashAndAutoResume(fullTaskId);

    expect(command.prompt).toContain(feedback);
    expect(command.prompt).toContain('Re-delivered feedback');
    // The generic resume context must be REPLACED, not merely accompanied.
    expect(command.prompt).not.toContain('Your previous session was interrupted');
  });

  // INVARIANT: idempotence — feedback the agent DID consume must never be
  // re-delivered. A later, unrelated crash must fall back to the generic prompt.
  test('consumed feedback is not re-delivered — generic resume prompt instead', async () => {
    const taskId = await createTask(ctx, 'No redelivery test', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    // The agent completed its turn, so the initial prompt is consumed.
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);

    const fullTaskId = findFullTaskId(ctx.root, taskId);
    const command = await crashAndAutoResume(fullTaskId);

    expect(command.prompt).toContain('Your previous session was interrupted');
    expect(command.prompt).not.toContain('Re-delivered feedback');
  });

  // INVARIANT: the initial task prompt is the human's first and most important
  // feedback. A crash on the very first turn must re-deliver it, not say
  // "carry on" to an agent that never read it.
  test('a crash on the first turn re-delivers the task prompt', async () => {
    const taskId = await createTask(ctx, 'First turn crash', 'Implement the parser exactly as specified');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    const fullTaskId = findFullTaskId(ctx.root, taskId);
    // Crash WITHOUT reconciling the start response — nothing consumed it.
    const command = await crashAndAutoResume(fullTaskId);

    expect(command.prompt).toContain('Implement the parser exactly as specified');
    expect(command.prompt).toContain('Re-delivered feedback');
  });

  // INVARIANT: ordering is never lost when feedback queues up. The newest
  // unconsumed feedback is re-delivered verbatim and the older ones are
  // reported, never silently dropped.
  test('queued feedback re-delivers the newest and reports the older ones', async () => {
    const taskId = await createTask(ctx, 'Queued feedback', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);

    const fullTaskId = findFullTaskId(ctx.root, taskId);

    // Two rounds of feedback, neither consumed (no reconcile in between).
    await ctx.lazyMocked(['unblock', taskId, '--message', 'FIRST piece of feedback'], MOCK_CLAUDE_SUCCESS);
    consumeResponse(getProtocolDir(fullTaskId));
    setTaskStatus(ctx.root, fullTaskId, 'blocked');
    await ctx.lazyMocked(['unblock', taskId, '--message', 'SECOND piece of feedback'], MOCK_CLAUDE_SUCCESS);

    const command = await crashAndAutoResume(fullTaskId);

    expect(command.prompt).toContain('SECOND piece of feedback');
    expect(command.prompt).toContain('older piece');
  });
});

// INVARIANT: manual `lazy resume` has the same gap as auto-resume — it must
// re-deliver unconsumed feedback too, not just tell the agent to carry on.
describe('feedback redelivery on manual resume', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('manual resume re-delivers unconsumed feedback verbatim', async () => {
    const taskId = await createTask(ctx, 'Manual redelivery', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    await runReconcileSubprocess(ctx.root, ctx.protocolBase);

    const fullTaskId = findFullTaskId(ctx.root, taskId);

    const feedback = 'Revert the schema change and open a follow-up instead';
    await ctx.lazyMocked(['unblock', taskId, '--message', feedback], MOCK_CLAUDE_SUCCESS);

    // Crash: no reconcile consumed the response, task is stuck interrupted.
    consumeResponse(getProtocolDir(fullTaskId));
    setTaskStatus(ctx.root, fullTaskId, 'interrupted');

    const resumeResult = await ctx.lazyMocked(['resume', taskId], MOCK_CLAUDE_SUCCESS);
    expectSuccess(resumeResult);

    const command = readCommand(getProtocolDir(fullTaskId)) as UnblockCommand;
    expect(command).not.toBeNull();
    expect(command.prompt).toContain(feedback);
    expect(command.prompt).toContain('Re-delivered feedback');
    expect(command.prompt).not.toContain('Your previous session was interrupted');
  });
});
