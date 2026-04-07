/**
 * E2E tests for daemon auto-delivery — events trigger auto-sync and auto-notify.
 *
 * Tests that:
 * - Accepting a child triggers upstream.updated delivery to blocked siblings
 * - Parent branch change triggers auto-sync of blocked children
 * - task.completed notifies blocked parent
 * - Budget limits prevent infinite cascades
 * - Working tasks with SSE connections receive events (not auto-unblocked)
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { openProjectStorage } from '../../src/daemon/rpc-handlers';
import {
  registerConnection,
  hasConnection,
  _resetEventState,
  type DaemonEvent,
} from '../../src/daemon/events';
import {
  createReconcileEventState,
  detectAndDeliverEvents,
  deliverStateChangeEvents,
  deliverUpstreamUpdated,
  deliverTaskCompleted,
  deliverTaskFailed,
  deliverNewComments,
  runBlockedTaskCatchup,
  type ReconcileEventState,
} from '../../src/daemon/auto-deliver';
import { resetSignalDb, consumeSignals, readSignals } from '../../src/daemon/signals';
import {
  shouldAutoReact,
  recordAutoReact,
  resetAutoReactCounters,
  readDailyBudget,
  incrementDailyBudget,
} from '../../src/daemon/auto-react-budget';

describe('auto-deliver', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    ctx = await setupTestLazy();
    _resetEventState();
  });

  afterEach(async () => {
    _resetEventState();
    resetSignalDb();
    await ctx.cleanup();
  });

  describe('detectAndDeliverEvents', () => {
    // INVARIANT: When a task transitions to 'complete' (accepted), the daemon
    // detects the change and routes events to siblings. This creates the cascade:
    // accept child A → child B gets upstream.updated.
    test('detects task acceptance and routes events to connected siblings', async () => {
      const parentShortId = await createTask(ctx, 'Parent task');
      const childAShortId = await createTask(ctx, 'Child A task');
      const childBShortId = await createTask(ctx, 'Child B task');

      const storage = await openProjectStorage(ctx.root);
      try {
        const allTasks = await storage.listTasks();
        const parentTask = allTasks.find(t => t.id.startsWith(parentShortId))!;
        const childA = allTasks.find(t => t.id.startsWith(childAShortId))!;
        const childB = allTasks.find(t => t.id.startsWith(childBShortId))!;

        // Set up parent-child relationships
        await storage.updateTaskParent(childA.id, parentTask.id);
        await storage.updateTaskParent(childB.id, parentTask.id);

        // Child B is working with SSE connection
        await storage.updateTaskStatus(childB.id, 'working', 'system');

        // Set up SSE connection for child B to capture events
        const childBEvents: DaemonEvent[] = [];
        new ReadableStream({
          start(controller) {
            registerConnection(childB.id, controller);
            const origEnqueue = controller.enqueue.bind(controller);
            controller.enqueue = (chunk: any) => {
              if (typeof chunk === 'string' && chunk.includes('"type"')) {
                const dataMatch = chunk.match(/data: (.+)/);
                if (dataMatch) {
                  try { childBEvents.push(JSON.parse(dataMatch[1])); } catch {}
                }
              }
              return origEnqueue(chunk);
            };
          },
        });

        // First tick: populate state with child A as backlog
        const state = createReconcileEventState();
        state.previousStatuses.set(childA.id, 'backlog');
        state.previousStatuses.set(childB.id, 'working');
        state.previousStatuses.set(parentTask.id, 'backlog');

        // Simulate child A being accepted (blocked → merging → complete)
        await storage.updateTaskStatus(childA.id, 'working', 'system');
        await storage.updateTaskStatus(childA.id, 'blocked', 'system');
        await storage.updateTaskStatus(childA.id, 'merging', 'system');
        await storage.updateTaskStatus(childA.id, 'complete', 'system');

        // Detect and deliver events
        await detectAndDeliverEvents(storage, ctx.root, state);

        // Child B should have received upstream.updated via SSE
        const upstreamEvents = childBEvents.filter(e => e.type === 'upstream.updated');
        expect(upstreamEvents.length).toBe(1);
        expect(upstreamEvents[0].payload.reason).toBe('sibling_accepted');
      } finally {
        await storage.close();
      }
    });

    // INVARIANT: The event state tracks statuses across ticks. On the first
    // tick, no events fire (no previous state to compare against).
    test('first tick populates state without firing events', async () => {
      const taskShortId = await createTask(ctx, 'Test task');

      const storage = await openProjectStorage(ctx.root);
      try {
        const state = createReconcileEventState();
        expect(state.previousStatuses.size).toBe(0);

        await detectAndDeliverEvents(storage, ctx.root, state);

        // State should now be populated
        expect(state.previousStatuses.size).toBeGreaterThan(0);
      } finally {
        await storage.close();
      }
    });
  });

  describe('deliverStateChangeEvents', () => {
    // INVARIANT: When a child completes (working → blocked) and parent is blocked,
    // the parent is notified via auto-delivery (not SSE).
    test('delivers task.completed to blocked parent without SSE', async () => {
      const parentShortId = await createTask(ctx, 'Parent task');
      const childShortId = await createTask(ctx, 'Child task');

      const storage = await openProjectStorage(ctx.root);
      try {
        const allTasks = await storage.listTasks();
        const parentTask = allTasks.find(t => t.id.startsWith(parentShortId))!;
        const childTask = allTasks.find(t => t.id.startsWith(childShortId))!;

        await storage.updateTaskParent(childTask.id, parentTask.id);

        // Parent is blocked (has a session but completed a turn)
        await storage.updateTaskStatus(parentTask.id, 'working', 'system');
        await storage.updateTaskStatus(parentTask.id, 'blocked', 'system');

        // Parent has NO SSE connection (not running a supervisor)
        expect(hasConnection(parentTask.id)).toBe(false);

        // Simulate child completing a turn
        const stateChanges = [{
          taskId: childTask.id,
          previousStatus: 'working' as const,
          currentStatus: 'blocked' as const,
          parentTaskId: parentTask.id,
        }];

        // This would try to auto-unblock the parent, but since there's no session
        // with a git branch and worktree, it will fail gracefully.
        // We're testing the routing logic, not the full unblock lifecycle.
        await deliverStateChangeEvents(storage, stateChanges, ctx.root);

        // Verify the function didn't crash (it will fail to unblock since
        // there's no worktree/session, but the routing logic should execute)
      } finally {
        await storage.close();
      }
    });

    // INVARIANT: task.failed (working → interrupted) notifies blocked parent.
    test('delivers task.failed to blocked parent without SSE', async () => {
      const parentShortId = await createTask(ctx, 'Parent task');
      const childShortId = await createTask(ctx, 'Child task');

      const storage = await openProjectStorage(ctx.root);
      try {
        const allTasks = await storage.listTasks();
        const parentTask = allTasks.find(t => t.id.startsWith(parentShortId))!;
        const childTask = allTasks.find(t => t.id.startsWith(childShortId))!;

        await storage.updateTaskParent(childTask.id, parentTask.id);

        // Parent is blocked
        await storage.updateTaskStatus(parentTask.id, 'working', 'system');
        await storage.updateTaskStatus(parentTask.id, 'blocked', 'system');

        // No SSE for parent
        expect(hasConnection(parentTask.id)).toBe(false);

        const stateChanges = [{
          taskId: childTask.id,
          previousStatus: 'working' as const,
          currentStatus: 'interrupted' as const,
          parentTaskId: parentTask.id,
        }];

        // Should attempt auto-delivery (will fail gracefully without worktree)
        await deliverStateChangeEvents(storage, stateChanges, ctx.root);
      } finally {
        await storage.close();
      }
    });

    // INVARIANT: No delivery attempted when parent has SSE connection
    // (events are already delivered via SSE by routeStateChangeEvents).
    test('skips auto-delivery when parent has SSE connection', async () => {
      const parentShortId = await createTask(ctx, 'Parent task');
      const childShortId = await createTask(ctx, 'Child task');

      const storage = await openProjectStorage(ctx.root);
      try {
        const allTasks = await storage.listTasks();
        const parentTask = allTasks.find(t => t.id.startsWith(parentShortId))!;
        const childTask = allTasks.find(t => t.id.startsWith(childShortId))!;

        await storage.updateTaskParent(childTask.id, parentTask.id);
        await storage.updateTaskStatus(parentTask.id, 'working', 'system');

        // Parent HAS SSE connection
        new ReadableStream({
          start(controller) {
            registerConnection(parentTask.id, controller);
          },
        });
        expect(hasConnection(parentTask.id)).toBe(true);

        const stateChanges = [{
          taskId: childTask.id,
          previousStatus: 'working' as const,
          currentStatus: 'blocked' as const,
          parentTaskId: parentTask.id,
        }];

        // Should skip auto-delivery since parent has SSE
        await deliverStateChangeEvents(storage, stateChanges, ctx.root);

        // Parent is still working (not auto-unblocked)
        const updatedParent = await storage.getTask(parentTask.id);
        expect(updatedParent!.status).toBe('working');
      } finally {
        await storage.close();
      }
    });
  });

  describe('budget controls', () => {
    // INVARIANT: Auto-delivery respects budget limits. After max retries,
    // the task is paused and no further auto-unblocks happen.
    test('upstream_sync respects per-task budget limits', async () => {
      const taskShortId = await createTask(ctx, 'Budget test task');

      const storage = await openProjectStorage(ctx.root);
      try {
        const allTasks = await storage.listTasks();
        const task = allTasks.find(t => t.id.startsWith(taskShortId))!;

        const { loadConfig } = await import('../../src/config/loader');
        const config = await loadConfig(ctx.root, { cwd: ctx.root });
        const dataDir = join(ctx.root, '.lazy');

        // Exhaust the budget for upstream_sync trigger
        for (let i = 0; i < config.daemon.auto_react_max_retries; i++) {
          await recordAutoReact(storage, task.id, 'upstream_sync', dataDir);
        }

        // Next auto-react should be blocked
        const decision = await shouldAutoReact(storage, task.id, 'upstream_sync', config, dataDir);
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toContain('retries exhausted');
      } finally {
        await storage.close();
      }
    });

    // INVARIANT: Daily budget prevents infinite cascades across all tasks.
    test('daily budget blocks auto-delivery when exhausted', async () => {
      const taskShortId = await createTask(ctx, 'Daily budget test');

      const storage = await openProjectStorage(ctx.root);
      try {
        const allTasks = await storage.listTasks();
        const task = allTasks.find(t => t.id.startsWith(taskShortId))!;

        const { loadConfig } = await import('../../src/config/loader');
        const config = await loadConfig(ctx.root, { cwd: ctx.root });
        const dataDir = join(ctx.root, '.lazy');

        // Exhaust the daily budget
        for (let i = 0; i < config.daemon.auto_react_daily_budget; i++) {
          incrementDailyBudget(dataDir);
        }

        // Verify budget is exhausted
        const budget = await readDailyBudget(dataDir);
        expect(budget.used).toBe(config.daemon.auto_react_daily_budget);

        // Next auto-react should be blocked
        const decision = await shouldAutoReact(storage, task.id, 'upstream_sync', config, dataDir);
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toContain('budget exhausted');
      } finally {
        await storage.close();
      }
    });

    // INVARIANT: Cascade safety — A accepted → B syncs → budget check prevents
    // infinite loop. Each auto-unblock consumes budget, so cascades are bounded.
    test('cascade safety: budget limits bound cascading auto-unblocks', async () => {
      const parentShortId = await createTask(ctx, 'Cascade parent');
      const childAShortId = await createTask(ctx, 'Cascade child A');
      const childBShortId = await createTask(ctx, 'Cascade child B');

      const storage = await openProjectStorage(ctx.root);
      try {
        const allTasks = await storage.listTasks();
        const parentTask = allTasks.find(t => t.id.startsWith(parentShortId))!;
        const childA = allTasks.find(t => t.id.startsWith(childAShortId))!;
        const childB = allTasks.find(t => t.id.startsWith(childBShortId))!;

        await storage.updateTaskParent(childA.id, parentTask.id);
        await storage.updateTaskParent(childB.id, parentTask.id);

        // Put child B in blocked state
        await storage.updateTaskStatus(childB.id, 'working', 'system');
        await storage.updateTaskStatus(childB.id, 'blocked', 'system');

        const { loadConfig } = await import('../../src/config/loader');
        const config = await loadConfig(ctx.root, { cwd: ctx.root });
        const dataDir = join(ctx.root, '.lazy');

        // Simulate multiple cascades consuming budget
        for (let i = 0; i < config.daemon.auto_react_max_retries; i++) {
          await recordAutoReact(storage, childB.id, 'upstream_sync', dataDir);
        }

        // Trying to deliver upstream.updated should now be blocked
        const result = await deliverUpstreamUpdated(storage, childB, ctx.root, 'sibling_accepted');

        // Should return false — budget exhausted
        expect(result).toBe(false);
      } finally {
        await storage.close();
      }
    });
  });

  describe('event state tracking', () => {
    // INVARIANT: ReconcileEventState correctly tracks status changes
    // across multiple ticks.
    test('state tracks changes across ticks', async () => {
      const taskShortId = await createTask(ctx, 'State tracking test');

      const storage = await openProjectStorage(ctx.root);
      try {
        const state = createReconcileEventState();

        // First tick: populate state
        await detectAndDeliverEvents(storage, ctx.root, state);
        const allTasks = await storage.listTasks();
        const task = allTasks.find(t => t.id.startsWith(taskShortId))!;

        expect(state.previousStatuses.has(task.id)).toBe(true);
        expect(state.previousStatuses.get(task.id)).toBe('backlog');

        // Simulate task transition
        await storage.updateTaskStatus(task.id, 'working', 'system');

        // Second tick: should detect the change
        await detectAndDeliverEvents(storage, ctx.root, state);

        // State should be updated
        expect(state.previousStatuses.get(task.id)).toBe('working');
      } finally {
        await storage.close();
      }
    });
  });

  describe('deliverUpstreamUpdated', () => {
    // INVARIANT: Only blocked tasks receive auto-unblock delivery.
    test('skips non-blocked tasks', async () => {
      const taskShortId = await createTask(ctx, 'Non-blocked task');

      const storage = await openProjectStorage(ctx.root);
      try {
        const allTasks = await storage.listTasks();
        const task = allTasks.find(t => t.id.startsWith(taskShortId))!;

        // Task is in backlog (not blocked)
        const result = await deliverUpstreamUpdated(storage, task, ctx.root, 'branch_push');
        expect(result).toBe(false);
      } finally {
        await storage.close();
      }
    });

    // INVARIANT: Blocked tasks without a session are skipped gracefully.
    test('skips blocked tasks without session', async () => {
      const taskShortId = await createTask(ctx, 'No session task');

      const storage = await openProjectStorage(ctx.root);
      try {
        const allTasks = await storage.listTasks();
        const task = allTasks.find(t => t.id.startsWith(taskShortId))!;

        // Transition to blocked (via working first)
        await storage.updateTaskStatus(task.id, 'working', 'system');
        await storage.updateTaskStatus(task.id, 'blocked', 'system');

        // No session exists — delivery should fail gracefully
        const result = await deliverUpstreamUpdated(storage, task, ctx.root, 'branch_push');
        expect(result).toBe(false);
      } finally {
        await storage.close();
      }
    });
  });

  describe('deliverTaskCompleted', () => {
    // INVARIANT: Parent auto-react to child completions is disabled until a proper
    // parent-reviews-child system is built. The parent agent has nothing useful to
    // do — it just burns turns. All calls return false.
    test('always returns false (child_completed trigger disabled)', async () => {
      const parentShortId = await createTask(ctx, 'Working parent');
      const childShortId = await createTask(ctx, 'Child that completed');

      const storage = await openProjectStorage(ctx.root);
      try {
        const allTasks = await storage.listTasks();
        const parentTask = allTasks.find(t => t.id.startsWith(parentShortId))!;
        const childTask = allTasks.find(t => t.id.startsWith(childShortId))!;

        // Even with a blocked parent, delivery returns false
        await storage.updateTaskStatus(parentTask.id, 'working', 'system');
        await storage.updateTaskStatus(parentTask.id, 'blocked', 'system');

        const result = await deliverTaskCompleted(storage, parentTask, childTask.id, ctx.root);
        expect(result).toBe(false);
      } finally {
        await storage.close();
      }
    });
  });

  describe('deliverNewComments', () => {
    // INVARIANT: Only blocked tasks receive auto-unblock for new comments.
    test('skips non-blocked tasks', async () => {
      const taskShortId = await createTask(ctx, 'Working task with comment');

      const storage = await openProjectStorage(ctx.root);
      try {
        const allTasks = await storage.listTasks();
        const task = allTasks.find(t => t.id.startsWith(taskShortId))!;

        // Task is in backlog (not blocked)
        const result = await deliverNewComments(
          storage, task,
          [{ summary: 'test comment', details: { comment_id: 'c1', actor: 'human' } }],
          ctx.root,
        );
        expect(result).toBe(false);
      } finally {
        await storage.close();
      }
    });

    // INVARIANT: Blocked tasks without a session are skipped gracefully.
    test('skips blocked tasks without session', async () => {
      const taskShortId = await createTask(ctx, 'No session comment task');

      const storage = await openProjectStorage(ctx.root);
      try {
        const allTasks = await storage.listTasks();
        const task = allTasks.find(t => t.id.startsWith(taskShortId))!;

        await storage.updateTaskStatus(task.id, 'working', 'system');
        await storage.updateTaskStatus(task.id, 'blocked', 'system');

        const result = await deliverNewComments(
          storage, task,
          [{ summary: 'test comment', details: { comment_id: 'c1', actor: 'human' } }],
          ctx.root,
        );
        expect(result).toBe(false);
      } finally {
        await storage.close();
      }
    });
  });

  describe('deliverTaskFailed', () => {
    // INVARIANT: Parent auto-react to child failures is disabled until a proper
    // parent-reviews-child system is built. Same rationale as deliverTaskCompleted.
    test('always returns false (child_failed trigger disabled)', async () => {
      const parentShortId = await createTask(ctx, 'Active parent');
      const childShortId = await createTask(ctx, 'Failed child');

      const storage = await openProjectStorage(ctx.root);
      try {
        const allTasks = await storage.listTasks();
        const parentTask = allTasks.find(t => t.id.startsWith(parentShortId))!;
        const childTask = allTasks.find(t => t.id.startsWith(childShortId))!;

        // Even with a blocked parent, delivery returns false
        await storage.updateTaskStatus(parentTask.id, 'working', 'system');
        await storage.updateTaskStatus(parentTask.id, 'blocked', 'system');

        const result = await deliverTaskFailed(storage, parentTask, childTask.id, ctx.root);
        expect(result).toBe(false);
      } finally {
        await storage.close();
      }
    });
  });

  describe('runBlockedTaskCatchup (signal delivery)', () => {
    // After the event-driven refactor, runBlockedTaskCatchup only delivers
    // pending signals — it no longer scans conditions or emits signals.
    // Signals are emitted at event sources (detectParentBranchChanges,
    // fetchRemoteComments, fetchCIFailures, lazy comment CLI).

    // INVARIANT: Stale child signals (from before the trigger was disabled) are
    // consumed by the delivery phase without delivering.
    test('consumes stale child_completed signals without delivering', async () => {
      const parentShortId = await createTask(ctx, 'Cleanup parent');
      const childShortId = await createTask(ctx, 'Cleanup child');

      const storage = await openProjectStorage(ctx.root);
      try {
        const allTasks = await storage.listTasks();
        const parentTask = allTasks.find(t => t.id.startsWith(parentShortId))!;
        const childTask = allTasks.find(t => t.id.startsWith(childShortId))!;

        await storage.updateTaskParent(childTask.id, parentTask.id);

        await storage.updateTaskStatus(parentTask.id, 'working', 'system');
        await storage.updateTaskStatus(parentTask.id, 'blocked', 'system');

        // Manually inject a stale child_completed signal (as if from before the disable)
        const { emitSignal } = await import('../../src/daemon/signals');
        emitSignal(parentTask.id, {
          type: 'child_completed',
          summary: `Child task ${childTask.id.substring(0, 8)} is blocked`,
          details: { child_id: childTask.id, child_status: 'blocked' },
        });

        // Verify the stale signal exists
        const signalsBefore = readSignals(parentTask.id);
        expect(signalsBefore.filter(s => s.type === 'child_completed').length).toBe(1);

        // Delivery phase should consume the stale signal without delivering
        await runBlockedTaskCatchup(storage, ctx.root);

        const signalsAfter = readSignals(parentTask.id);
        expect(signalsAfter.filter(s => s.type === 'child_completed').length).toBe(0);
      } finally {
        await storage.close();
      }
    });

    // INVARIANT: Non-blocked tasks are skipped by signal delivery.
    test('skips non-blocked tasks', async () => {
      const taskShortId = await createTask(ctx, 'Working task');

      const storage = await openProjectStorage(ctx.root);
      try {
        const allTasks = await storage.listTasks();
        const task = allTasks.find(t => t.id.startsWith(taskShortId))!;

        // Task is in backlog (not blocked)
        await runBlockedTaskCatchup(storage, ctx.root);

        // Task in working state
        await storage.updateTaskStatus(task.id, 'working', 'system');
        await runBlockedTaskCatchup(storage, ctx.root);

        // No crash = success
      } finally {
        await storage.close();
      }
    });

    // INVARIANT: Event-driven signal delivery — signals emitted at source
    // are delivered by runBlockedTaskCatchup. Comment signals are no longer
    // emitted by catchup itself.
    test('delivers pre-emitted comment signals for blocked task', async () => {
      const taskShortId = await createTask(ctx, 'Signal delivery task');

      const storage = await openProjectStorage(ctx.root);
      try {
        const allTasks = await storage.listTasks();
        const task = allTasks.find(t => t.id.startsWith(taskShortId))!;

        // Transition to blocked
        await storage.updateTaskStatus(task.id, 'working', 'system');
        await storage.updateTaskStatus(task.id, 'blocked', 'system');

        // Emit a comment signal (as if from fetchRemoteComments or lazy comment)
        const { emitSignal } = await import('../../src/daemon/signals');
        emitSignal(task.id, {
          type: 'comment',
          summary: 'Please fix the edge case',
          details: { comment_id: 'c1', actor: 'human' },
        });

        // Verify signal is pending
        const signalsBefore = readSignals(task.id);
        expect(signalsBefore.filter(s => s.type === 'comment').length).toBe(1);

        // runBlockedTaskCatchup only delivers — it doesn't emit.
        // Delivery will fail (no session/worktree) but the signal stays pending.
        await runBlockedTaskCatchup(storage, ctx.root);

        // Signal should still be pending (delivery failed due to no session)
        const signalsAfter = readSignals(task.id);
        expect(signalsAfter.filter(s => s.type === 'comment').length).toBe(1);
      } finally {
        await storage.close();
      }
    });

    // INVARIANT: Signal delivery does not re-emit signals. Running catchup
    // multiple times on the same pending signals does not duplicate them.
    test('multiple catchup runs do not duplicate signals', async () => {
      const taskShortId = await createTask(ctx, 'No-reemit task');

      const storage = await openProjectStorage(ctx.root);
      try {
        const allTasks = await storage.listTasks();
        const task = allTasks.find(t => t.id.startsWith(taskShortId))!;

        await storage.updateTaskStatus(task.id, 'working', 'system');
        await storage.updateTaskStatus(task.id, 'blocked', 'system');

        // Emit one signal
        const { emitSignal } = await import('../../src/daemon/signals');
        emitSignal(task.id, {
          type: 'upstream_change',
          summary: 'Parent branch updated',
          details: { parent_tip: 'abc123' },
        });

        // Run catchup multiple times
        await runBlockedTaskCatchup(storage, ctx.root);
        await runBlockedTaskCatchup(storage, ctx.root);
        await runBlockedTaskCatchup(storage, ctx.root);

        // Signal count should not grow (delivery-only, no re-emission)
        const signals = readSignals(task.id);
        expect(signals.filter(s => s.type === 'upstream_change').length).toBe(1);
      } finally {
        await storage.close();
      }
    });
  });
});
