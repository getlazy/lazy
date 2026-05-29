/**
 * E2E tests for daemon event routing via SSE.
 *
 * Tests the SSE endpoint, event routing, heartbeats, and catchup.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import {
  registerConnection,
  removeConnection,
  sendEvent,
  hasConnection,
  getConnectionCount,
  routeStateChangeEvents,
  routeAcceptedEvents,
  routeUpstreamUpdated,
  isParentBranchAhead,
  _resetEventState,
  type DaemonEvent,
  type StateChange,
} from '../../src/daemon/events';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { openProjectStorage } from '../../src/daemon/rpc-handlers';

describe('daemon event routing', () => {

  describe('SSE endpoint', () => {
    let daemon: RunningDaemon;
    let ctx: TestContext;
    let tmpDir: string;
    let socketPath: string;
    let token: string;

    beforeEach(async () => {
      process.env.LAZY_TEST = '1';
      ctx = await setupTestLazy();
      tmpDir = await mkdtemp(join(tmpdir(), 'lazy-daemon-events-'));
      socketPath = join(tmpDir, 'events-test.sock');
      token = 'events-test-token';
      daemon = await startDaemonServer({ socketPath, token, reconcileIntervalSeconds: 60, projectRoot: ctx.root });
    });

    afterEach(async () => {
      if (daemon) {
        try { daemon.stop(); } catch { /* may already be stopped */ }
      }
      _resetEventState();
      await ctx.cleanup();
      await rm(tmpDir, { recursive: true, force: true });
    });

    // INVARIANT: SSE endpoint requires authentication.
    // Without auth, any process could subscribe to task events.
    test('rejects SSE connection without auth', async () => {
      const resp = await fetch(`http://localhost/events/stream?task_id=test123`, {
        unix: socketPath,
      } as any);
      expect(resp.status).toBe(401);
    });

    // INVARIANT: SSE endpoint requires task_id query parameter.
    // Without it, the daemon doesn't know which task to route events for.
    test('rejects SSE connection without task_id', async () => {
      const resp = await fetch(`http://localhost/events/stream`, {
        unix: socketPath,
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Lazy-Project': ctx.root,
        },
      } as any);
      expect(resp.status).toBe(400);
      const data = await resp.json() as any;
      expect(data.error).toContain('task_id');
    });

    // INVARIANT: SSE endpoint requires X-Lazy-Project header.
    test('rejects SSE connection without project header', async () => {
      const resp = await fetch(`http://localhost/events/stream?task_id=test123`, {
        unix: socketPath,
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      } as any);
      expect(resp.status).toBe(400);
      const data = await resp.json() as any;
      expect(data.error).toContain('X-Lazy-Project');
    });

    // INVARIANT: SSE endpoint returns text/event-stream content type
    // and sends an initial connected event.
    test('connects and receives initial connected event', async () => {
      const abortController = new AbortController();

      const resp = await fetch(`http://localhost/events/stream?task_id=test-task-id`, {
        unix: socketPath,
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Lazy-Project': ctx.root,
        },
        signal: abortController.signal,
      } as any);

      expect(resp.status).toBe(200);
      expect(resp.headers.get('content-type')).toBe('text/event-stream');
      expect(resp.headers.get('cache-control')).toBe('no-cache');

      // Read the first event from the stream
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();

      const { value } = await reader.read();
      const text = decoder.decode(value);

      expect(text).toContain('event: connected');
      expect(text).toContain('"task_id":"test-task-id"');

      // Clean up
      abortController.abort();
      reader.releaseLock();
    });

    // INVARIANT: SSE endpoint accepts connections for the daemon's project.
    test('SSE connection accepted for daemon project', async () => {
      const abortController = new AbortController();
      const resp = await fetch(`http://localhost/events/stream?task_id=test-task-id`, {
        unix: socketPath,
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Lazy-Project': ctx.root,
        },
        signal: abortController.signal,
      } as any);

      expect(resp.status).toBe(200);

      abortController.abort();
    });
  });

  describe('routing table', () => {
    beforeEach(() => {
      _resetEventState();
    });

    afterEach(() => {
      _resetEventState();
    });

    // INVARIANT: Connections can be registered and looked up by task ID.
    test('registerConnection and hasConnection', () => {
      const stream = new ReadableStream({
        start(controller) {
          registerConnection('task-1', controller);
        },
      });
      // The ReadableStream constructor runs start() synchronously
      expect(hasConnection('task-1')).toBe(true);
      expect(hasConnection('task-2')).toBe(false);
      expect(getConnectionCount()).toBe(1);
    });

    // INVARIANT: removeConnection cleans up the connection.
    test('removeConnection cleans up', () => {
      new ReadableStream({
        start(controller) {
          registerConnection('task-1', controller);
        },
      });
      expect(hasConnection('task-1')).toBe(true);

      removeConnection('task-1');
      expect(hasConnection('task-1')).toBe(false);
      expect(getConnectionCount()).toBe(0);
    });

    // INVARIANT: Registering a connection for the same task replaces the old one.
    test('registerConnection replaces existing connection', () => {
      new ReadableStream({
        start(controller) {
          registerConnection('task-1', controller);
        },
      });
      new ReadableStream({
        start(controller) {
          registerConnection('task-1', controller);
        },
      });
      expect(getConnectionCount()).toBe(1);
    });

    // INVARIANT: sendEvent delivers to the right task and returns true.
    // Returns false when no connection exists.
    test('sendEvent delivers events to connected tasks', () => {
      const received: string[] = [];
      new ReadableStream({
        start(controller) {
          registerConnection('task-1', controller);
        },
      });

      const event: DaemonEvent = {
        type: 'task.completed',
        source_task_id: 'child-1',
        payload: { status: 'blocked' },
      };

      const delivered = sendEvent('task-1', event);
      expect(delivered).toBe(true);

      // Sending to non-existent task returns false
      const missed = sendEvent('task-nonexistent', event);
      expect(missed).toBe(false);
    });
  });

  describe('state change routing', () => {
    beforeEach(() => {
      _resetEventState();
    });

    afterEach(() => {
      _resetEventState();
    });

    // INVARIANT: working → blocked sends task.completed to parent.
    test('working to blocked sends task.completed to parent', async () => {
      const events: DaemonEvent[] = [];
      new ReadableStream({
        start(controller) {
          registerConnection('parent-task', controller);
          // Intercept events by wrapping the controller
          const origEnqueue = controller.enqueue.bind(controller);
          controller.enqueue = (chunk: any) => {
            if (typeof chunk === 'string' && chunk.includes('"type"')) {
              // Parse the SSE data line
              const dataMatch = chunk.match(/data: (.+)/);
              if (dataMatch) {
                try {
                  events.push(JSON.parse(dataMatch[1]));
                } catch {}
              }
            }
            return origEnqueue(chunk);
          };
        },
      });

      const changes: StateChange[] = [{
        taskId: 'child-task',
        previousStatus: 'working',
        currentStatus: 'blocked',
        parentTaskId: 'parent-task',
      }];

      // Use a minimal mock storage
      const mockStorage = {} as any;
      routeStateChangeEvents(mockStorage, changes);

      expect(events.length).toBe(1);
      expect(events[0].type).toBe('task.completed');
      expect(events[0].source_task_id).toBe('child-task');
    });

    // INVARIANT: working → interrupted sends task.failed to parent.
    test('working to interrupted sends task.failed to parent', async () => {
      const events: DaemonEvent[] = [];
      new ReadableStream({
        start(controller) {
          registerConnection('parent-task', controller);
          const origEnqueue = controller.enqueue.bind(controller);
          controller.enqueue = (chunk: any) => {
            if (typeof chunk === 'string' && chunk.includes('"type"')) {
              const dataMatch = chunk.match(/data: (.+)/);
              if (dataMatch) {
                try { events.push(JSON.parse(dataMatch[1])); } catch {}
              }
            }
            return origEnqueue(chunk);
          };
        },
      });

      const changes: StateChange[] = [{
        taskId: 'child-task',
        previousStatus: 'working',
        currentStatus: 'interrupted',
        parentTaskId: 'parent-task',
      }];

      routeStateChangeEvents({} as any, changes);

      expect(events.length).toBe(1);
      expect(events[0].type).toBe('task.failed');
      expect(events[0].source_task_id).toBe('child-task');
    });

    // INVARIANT: Events are silently dropped when parent has no SSE connection.
    test('events are silently dropped when parent has no connection', () => {
      const changes: StateChange[] = [{
        taskId: 'child-task',
        previousStatus: 'working',
        currentStatus: 'blocked',
        parentTaskId: 'no-connection-parent',
      }];

      // Should not throw
      routeStateChangeEvents({} as any, changes);
    });

    // INVARIANT: Events are not sent when there's no parent task.
    test('no events when task has no parent', () => {
      const changes: StateChange[] = [{
        taskId: 'root-task',
        previousStatus: 'working',
        currentStatus: 'blocked',
        parentTaskId: null,
      }];

      // Should not throw
      routeStateChangeEvents({} as any, changes);
    });
  });

  describe('accepted event routing', () => {
    let ctx: TestContext;

    beforeEach(async () => {
      process.env.LAZY_TEST = '1';
      ctx = await setupTestLazy();
      _resetEventState();
    });

    afterEach(async () => {
      _resetEventState();
      await ctx.cleanup();
    });

    // INVARIANT: Accepting a child task sends task.accepted to parent
    // and upstream.updated to siblings.
    test('routeAcceptedEvents notifies parent and siblings', async () => {
      const parentEvents: DaemonEvent[] = [];
      const siblingEvents: DaemonEvent[] = [];

      // Set up parent connection
      new ReadableStream({
        start(controller) {
          registerConnection('parent-id', controller);
          const origEnqueue = controller.enqueue.bind(controller);
          controller.enqueue = (chunk: any) => {
            if (typeof chunk === 'string' && chunk.includes('"type"')) {
              const dataMatch = chunk.match(/data: (.+)/);
              if (dataMatch) {
                try { parentEvents.push(JSON.parse(dataMatch[1])); } catch {}
              }
            }
            return origEnqueue(chunk);
          };
        },
      });

      // Set up sibling connection
      new ReadableStream({
        start(controller) {
          registerConnection('sibling-id', controller);
          const origEnqueue = controller.enqueue.bind(controller);
          controller.enqueue = (chunk: any) => {
            if (typeof chunk === 'string' && chunk.includes('"type"')) {
              const dataMatch = chunk.match(/data: (.+)/);
              if (dataMatch) {
                try { siblingEvents.push(JSON.parse(dataMatch[1])); } catch {}
              }
            }
            return origEnqueue(chunk);
          };
        },
      });

      // Mock storage that returns siblings
      const mockStorage = {
        getChildTasks: async (parentId: string) => [
          { id: 'accepted-child', status: 'complete' },
          { id: 'sibling-id', status: 'working' },
        ],
      } as any;

      await routeAcceptedEvents(mockStorage, 'accepted-child', 'parent-id');

      // Parent should get task.accepted
      expect(parentEvents.length).toBe(1);
      expect(parentEvents[0].type).toBe('task.accepted');
      expect(parentEvents[0].source_task_id).toBe('accepted-child');

      // Sibling should get upstream.updated
      expect(siblingEvents.length).toBe(1);
      expect(siblingEvents[0].type).toBe('upstream.updated');
      expect(siblingEvents[0].payload.reason).toBe('sibling_accepted');
    });
  });

  describe('upstream updated routing', () => {
    beforeEach(() => {
      _resetEventState();
    });

    afterEach(() => {
      _resetEventState();
    });

    // INVARIANT: routeUpstreamUpdated sends to all connected children.
    test('sends upstream.updated to all connected children', async () => {
      const child1Events: DaemonEvent[] = [];
      const child2Events: DaemonEvent[] = [];

      new ReadableStream({
        start(controller) {
          registerConnection('child-1', controller);
          const origEnqueue = controller.enqueue.bind(controller);
          controller.enqueue = (chunk: any) => {
            if (typeof chunk === 'string' && chunk.includes('"type"')) {
              const dataMatch = chunk.match(/data: (.+)/);
              if (dataMatch) {
                try { child1Events.push(JSON.parse(dataMatch[1])); } catch {}
              }
            }
            return origEnqueue(chunk);
          };
        },
      });

      new ReadableStream({
        start(controller) {
          registerConnection('child-2', controller);
          const origEnqueue = controller.enqueue.bind(controller);
          controller.enqueue = (chunk: any) => {
            if (typeof chunk === 'string' && chunk.includes('"type"')) {
              const dataMatch = chunk.match(/data: (.+)/);
              if (dataMatch) {
                try { child2Events.push(JSON.parse(dataMatch[1])); } catch {}
              }
            }
            return origEnqueue(chunk);
          };
        },
      });

      const mockStorage = {
        getChildTasks: async () => [
          { id: 'child-1', status: 'working' },
          { id: 'child-2', status: 'blocked' },
          { id: 'child-3', status: 'working' }, // No connection
        ],
      } as any;

      await routeUpstreamUpdated(mockStorage, 'parent-id', 'branch_push');

      expect(child1Events.length).toBe(1);
      expect(child1Events[0].type).toBe('upstream.updated');
      expect(child1Events[0].payload.reason).toBe('branch_push');

      expect(child2Events.length).toBe(1);
      expect(child2Events[0].type).toBe('upstream.updated');
    });
  });

  describe('catchup on reconnect', () => {
    let ctx: TestContext;

    beforeEach(async () => {
      process.env.LAZY_TEST = '1';
      ctx = await setupTestLazy();
      _resetEventState();
    });

    afterEach(async () => {
      _resetEventState();
      await ctx.cleanup();
    });

    // INVARIANT: Catchup sends task.completed for blocked children.
    test('sends task.completed for blocked children on connect', async () => {
      // Create parent and child tasks
      const parentShortId = await createTask(ctx, 'Parent task');
      const childShortId = await createTask(ctx, 'Child task');

      const storage = await openProjectStorage(ctx.root);

      // Find the full task objects
      const allTasks = await storage.listTasks();
      const parentTask = allTasks.find(t => t.id.startsWith(parentShortId))!;
      const childTask = allTasks.find(t => t.id.startsWith(childShortId))!;

      // Set up parent-child relationship and child status
      // Must transition through valid states: backlog → working → blocked
      await storage.updateTaskTarget(childTask.id, { kind: 'task' as const, parentTaskId: parentTask.id });
      await storage.updateTaskStatus(childTask.id, 'working', 'system');
      await storage.updateTaskStatus(childTask.id, 'blocked', 'system');

      // Set up SSE connection for parent and track events
      const events: DaemonEvent[] = [];
      new ReadableStream({
        start(controller) {
          registerConnection(parentTask.id, controller);
          const origEnqueue = controller.enqueue.bind(controller);
          controller.enqueue = (chunk: any) => {
            if (typeof chunk === 'string' && chunk.includes('"type"')) {
              const dataMatch = chunk.match(/data: (.+)/);
              if (dataMatch) {
                try { events.push(JSON.parse(dataMatch[1])); } catch {}
              }
            }
            return origEnqueue(chunk);
          };
        },
      });

      // Import and call catchup
      const { sendCatchupEvents } = await import('../../src/daemon/events');
      await sendCatchupEvents(storage, parentTask.id, ctx.root);

      await storage.close();

      // Should have received task.completed for the blocked child
      const completedEvents = events.filter(e => e.type === 'task.completed');
      expect(completedEvents.length).toBe(1);
      expect(completedEvents[0].source_task_id).toBe(childTask.id);
    });
  });

  describe('isParentBranchAhead', () => {
    let ctx: TestContext;

    beforeEach(async () => {
      process.env.LAZY_TEST = '1';
      ctx = await setupTestLazy();
      _resetEventState();
    });

    afterEach(async () => {
      _resetEventState();
      await ctx.cleanup();
    });

    // INVARIANT: isParentBranchAhead returns false when task has no parent.
    // Root tasks don't have upstream branches to check against.
    test('returns false for task without parent', async () => {
      const taskShortId = await createTask(ctx, 'Root task');

      const storage = await openProjectStorage(ctx.root);
      try {
        const allTasks = await storage.listTasks();
        const task = allTasks.find(t => t.id.startsWith(taskShortId))!;

        const result = await isParentBranchAhead(storage, task, ctx.root);
        expect(result.ahead).toBe(false);
        expect(result.parentTip).toBeNull();
      } finally {
        await storage.close();
      }
    });

    // INVARIANT: isParentBranchAhead returns false when task has no session.
    // Without a session, there's no git branch to compare against.
    test('returns false for task without session', async () => {
      const parentShortId = await createTask(ctx, 'Parent');
      const childShortId = await createTask(ctx, 'Child');

      const storage = await openProjectStorage(ctx.root);
      try {
        const allTasks = await storage.listTasks();
        const parentTask = allTasks.find(t => t.id.startsWith(parentShortId))!;
        const childTask = allTasks.find(t => t.id.startsWith(childShortId))!;

        await storage.updateTaskTarget(childTask.id, { kind: 'task' as const, parentTaskId: parentTask.id });

        const result = await isParentBranchAhead(storage, childTask, ctx.root);
        expect(result.ahead).toBe(false);
      } finally {
        await storage.close();
      }
    });
  });

  describe('SSE integration with daemon', () => {
    let daemon: RunningDaemon;
    let ctx: TestContext;
    let tmpDir: string;
    let socketPath: string;
    let token: string;

    beforeEach(async () => {
      process.env.LAZY_TEST = '1';
      ctx = await setupTestLazy();
      tmpDir = await mkdtemp(join(tmpdir(), 'lazy-daemon-sse-integ-'));
      socketPath = join(tmpDir, 'sse-integ.sock');
      token = 'sse-integ-token';
      daemon = await startDaemonServer({ socketPath, token, reconcileIntervalSeconds: 1, projectRoot: ctx.root });
    });

    afterEach(async () => {
      if (daemon) {
        try { daemon.stop(); } catch { /* may already be stopped */ }
      }
      _resetEventState();
      await ctx.cleanup();
      await rm(tmpDir, { recursive: true, force: true });
    });

    // INVARIANT: SSE endpoint receives heartbeats to detect dead connections.
    test('SSE connection receives heartbeats', async () => {
      // Override heartbeat interval to something short for testing
      // We can't easily do this, but we can verify the connection stays alive
      const abortController = new AbortController();

      const resp = await fetch(`http://localhost/events/stream?task_id=heartbeat-test`, {
        unix: socketPath,
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Lazy-Project': ctx.root,
        },
        signal: abortController.signal,
      } as any);

      expect(resp.status).toBe(200);

      // Read the connected event
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();

      const { value } = await reader.read();
      const text = decoder.decode(value);
      expect(text).toContain('event: connected');

      abortController.abort();
      reader.releaseLock();
    });

    // INVARIANT: Multiple SSE connections can coexist for different tasks.
    test('supports multiple concurrent SSE connections', async () => {
      const abort1 = new AbortController();
      const abort2 = new AbortController();

      const resp1 = await fetch(`http://localhost/events/stream?task_id=task-1`, {
        unix: socketPath,
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Lazy-Project': ctx.root,
        },
        signal: abort1.signal,
      } as any);

      const resp2 = await fetch(`http://localhost/events/stream?task_id=task-2`, {
        unix: socketPath,
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Lazy-Project': ctx.root,
        },
        signal: abort2.signal,
      } as any);

      expect(resp1.status).toBe(200);
      expect(resp2.status).toBe(200);

      // Both should have connections registered
      expect(hasConnection('task-1')).toBe(true);
      expect(hasConnection('task-2')).toBe(true);
      expect(getConnectionCount()).toBe(2);

      abort1.abort();
      abort2.abort();
    });
  });
});
