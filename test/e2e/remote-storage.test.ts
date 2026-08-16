/**
 * E2E tests for RemoteStorage — the daemon-as-single-writer proxy.
 *
 * Tests that CLI commands routed through RemoteStorage produce the same
 * results as direct storage, and that .storage-lock is not acquired by
 * CLI commands when the daemon is running.
 */

import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import { openProjectStorage } from '../../src/daemon/rpc-handlers';
import { RemoteStorage } from '../../src/storage/remote-storage';
import { DaemonClient } from '../../src/daemon/client';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTaskBeforeDaemon } from '../helpers/fixtures';
import { slowSuiteSkipped } from '../helpers/slow-suite';
import { isolateInProcessDaemonEnv } from '../helpers/in-process-daemon';

// Slow suite (>300s per file): opt in with LAZY_SLOW_TESTS=1. Gating only —
// no test content is weakened or removed.

// This suite runs a daemon IN-PROCESS; keep the LAZY_IS_DAEMON flag that
// startDaemonServer() sets process-wide from leaking into later test files.
isolateInProcessDaemonEnv();

describe.skipIf(slowSuiteSkipped('RemoteStorage'))('RemoteStorage', () => {
  let daemon: RunningDaemon;
  let ctx: TestContext;
  let tmpDir: string;
  let socketPath: string;
  let token: string;
  let cliTaskId: string;

  beforeAll(async () => {
    ctx = await setupTestLazy();
    // Created here, before the daemon exists: `lazy create` is a subprocess and
    // cannot take the storage lock the in-process daemon holds for its lifetime.
    cliTaskId = await createTaskBeforeDaemon(ctx, 'CLI created task for remote test');
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-remote-storage-'));
    socketPath = join(tmpDir, 'remote-storage-test.sock');
    token = 'remote-storage-test-token';
    daemon = await startDaemonServer({ socketPath, token, projectRoot: ctx.root });
  });

  afterAll(async () => {
    if (daemon) {
      try { await daemon.stop(); } catch { /* may already be stopped */ }
    }
    if (ctx) {
      await ctx.cleanup();
    }
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  function makeClient(): DaemonClient {
    return new (DaemonClient as any)(socketPath, token) as DaemonClient;
  }

  async function makeRemoteStorage(): Promise<RemoteStorage> {
    const client = makeClient();
    const storagePath = await client.rpc('storage', ctx.root, {
      method: 'getStoragePath',
      args: {},
    }) as string;
    return new RemoteStorage(client, ctx.root, storagePath);
  }

  // INVARIANT: RemoteStorage.getStoragePath() returns the same path as direct storage.
  // CLI commands use this for path construction — it must match.
  test('getStoragePath matches direct storage', async () => {
    const remote = await makeRemoteStorage();
    const direct = await openProjectStorage(ctx.root);
    try {
      expect(remote.getStoragePath()).toBe(direct.getStoragePath());
    } finally {
      await direct.close();
    }
  });

  // INVARIANT: RemoteStorage can create and retrieve tasks through the daemon.
  // This is the most basic read/write round-trip.
  test('createTask and getTask round-trip', async () => {
    const remote = await makeRemoteStorage();

    const task = await remote.createTask('Remote storage test task');
    expect(task).toBeDefined();
    expect(task.id).toBeTruthy();
    expect(task.goal).toBe('Remote storage test task');
    expect(task.status).toBe('backlog');

    const fetched = await remote.getTask(task.id.substring(0, 8));
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(task.id);
    expect(fetched!.goal).toBe('Remote storage test task');
  });

  // INVARIANT: per-turn launch labels survive the RPC hop. RemoteStorage forwards
  // CreateTurnOptions wholesale, so a field added to the interface reaches the
  // backing store without a RemoteStorage change — this test is what makes that
  // "no change needed" claim checkable instead of assumed. `model_id` must stay
  // ABSENT when the caller omitted it (never back-filled from `model`).
  test('createTurn round-trips model, model_id and effort through the daemon', async () => {
    const remote = await makeRemoteStorage();

    const task = await remote.createTask('Remote turn label round-trip');
    const session = await remote.createSession(task.id, 'claude-code', 'lazy/remote-labels', 'abc123');

    await remote.createTurn({
      sessionId: session.id, sequence: 0, role: 'agent', content: 'Labelled turn',
      model: 'opus', modelId: 'claude-opus-4-6-20260101', effort: 'high',
    });
    await remote.createTurn({
      sessionId: session.id, sequence: 1, role: 'agent', content: 'Alias-only turn', model: 'opus',
    });

    const turns = await remote.getSessionTurns(session.id);
    expect(turns[0].model).toBe('opus');
    expect(turns[0].model_id).toBe('claude-opus-4-6-20260101');
    expect(turns[0].effort).toBe('high');
    expect(turns[1].model).toBe('opus');
    expect(turns[1].model_id).toBeUndefined();
    expect(turns[1].effort).toBeUndefined();
  });

  // INVARIANT: RemoteStorage.listTasks returns all tasks visible via direct storage.
  // The daemon proxy must not filter or lose data.
  test('listTasks returns tasks created via CLI', async () => {
    const remote = await makeRemoteStorage();
    const tasks = await remote.listTasks();
    expect(tasks.length).toBeGreaterThan(0);
    const found = tasks.find(t => t.id.startsWith(cliTaskId));
    expect(found).toBeDefined();
    expect(found!.goal).toBe('CLI created task for remote test');
  });

  // INVARIANT: RemoteStorage write operations persist and are visible to direct storage.
  // Changes made through the proxy must land in the real storage.
  test('write operations persist to real storage', async () => {
    const remote = await makeRemoteStorage();
    const task = await remote.createTask('Persistence test');

    await remote.updateTaskGoal(task.id, 'Updated goal');
    await remote.updateTaskCode(task.id, 'test-persist');

    const direct = await openProjectStorage(ctx.root);
    try {
      const fetched = await direct.getTask(task.id.substring(0, 8));
      expect(fetched).toBeDefined();
      expect(fetched!.goal).toBe('Updated goal');
      expect(fetched!.code).toBe('test-persist');
    } finally {
      await direct.close();
    }
  });

  // INVARIANT: RemoteStorage correctly proxies session operations.
  test('session create and query', async () => {
    const remote = await makeRemoteStorage();
    const task = await remote.createTask('Session test');

    const gitResult = ctx.git('rev-parse', 'HEAD');
    const startSha = gitResult.stdout.trim();

    const session = await remote.createSession(task.id, 'test-agent', 'lazy/test-branch', startSha);
    expect(session).toBeDefined();
    expect(session.task_id).toBe(task.id);

    const fetched = await remote.getSessionByTaskId(task.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(session.id);
  });

  // INVARIANT: RemoteStorage correctly proxies comment operations.
  test('comment create and query', async () => {
    const remote = await makeRemoteStorage();
    const task = await remote.createTask('Comment test');

    const comment = await remote.createComment(task.id, 'Test comment content', 'human');
    expect(comment).toBeDefined();
    expect(comment.content).toBe('Test comment content');

    const comments = await remote.getTaskComments(task.id);
    expect(comments.length).toBe(1);
    expect(comments[0].content).toBe('Test comment content');
  });

  // INVARIANT: RemoteStorage correctly proxies resolveTask.
  test('resolveTask returns task by short ID', async () => {
    const remote = await makeRemoteStorage();
    const task = await remote.createTask('Resolve test');

    const result = await remote.resolveTask(task.id.substring(0, 8));
    expect(result.task).toBeDefined();
    expect(result.task!.id).toBe(task.id);
  });

  // INVARIANT: RemoteStorage correctly handles null returns.
  test('getTask returns null for nonexistent task', async () => {
    const remote = await makeRemoteStorage();
    const result = await remote.getTask('00000000');
    expect(result).toBeNull();
  });

  // INVARIANT: RemoteStorage correctly proxies listTasksWithOptions filtering.
  test('listTasksWithOptions filters correctly', async () => {
    const remote = await makeRemoteStorage();
    await remote.createTask('Blocked filter test');

    const nonTerminal = await remote.listTasksWithOptions({ nonTerminalOnly: true });
    expect(nonTerminal.length).toBeGreaterThan(0);

    const blocked = await remote.listTasksWithOptions({ blockedOnly: true });
    expect(blocked.length).toBe(0);
  });

  // INVARIANT: RemoteStorage correctly proxies search.
  test('search returns matching results', async () => {
    const remote = await makeRemoteStorage();
    await remote.createTask('Unicorn search target');

    const results = await remote.search('unicorn');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.content.toLowerCase().includes('unicorn'))).toBe(true);
  });

  // INVARIANT: RemoteStorage propagates errors from the daemon with context.
  test('errors include method name for debugging', async () => {
    const client = makeClient();
    const remote = new RemoteStorage(client, '/nonexistent/project', '/tmp/fake');

    try {
      await remote.listTasks();
      throw new Error('Should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('RemoteStorage.listTasks');
    }
  });

  // INVARIANT: Unknown storage methods return 404 error.
  test('unknown storage method returns error', async () => {
    const client = makeClient();
    try {
      await client.rpc('storage', ctx.root, { method: 'nonExistentMethod', args: {} });
      throw new Error('Should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('404');
    }
  });

  // INVARIANT: Storage RPC requires method parameter.
  test('storage RPC without method returns 400', async () => {
    const client = makeClient();
    try {
      await client.rpc('storage', ctx.root, { args: {} });
      throw new Error('Should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('400');
    }
  });

  // INVARIANT: RemoteStorage.getTaskDir returns correct path format.
  test('getTaskDir returns correct path', async () => {
    const remote = await makeRemoteStorage();
    const storagePath = remote.getStoragePath();
    const taskDir = remote.getTaskDir('test-uuid-1234');
    expect(taskDir).toBe(`${storagePath}/tasks/test-uuid-1234`);
  });

  // INVARIANT: initialize() and close() are no-ops on RemoteStorage.
  test('initialize and close are no-ops', async () => {
    const remote = await makeRemoteStorage();
    await remote.initialize();
    await remote.close();
  });

  // INVARIANT: RemoteStorage correctly proxies updateTaskStatus.
  test('updateTaskStatus changes task status', async () => {
    const remote = await makeRemoteStorage();
    const task = await remote.createTask('Status test');

    // backlog -> working is a valid transition
    await remote.updateTaskStatus(task.id, 'working');
    const updated = await remote.getTask(task.id.substring(0, 8));
    expect(updated!.status).toBe('working');
  });

  // INVARIANT: RemoteStorage correctly proxies abandonTask with reason.
  test('abandonTask sets close reason', async () => {
    const remote = await makeRemoteStorage();
    const task = await remote.createTask('Abandon test');

    await remote.abandonTask(task.id, 'Test abandon reason');
    const abandoned = await remote.getTask(task.id.substring(0, 8));
    expect(abandoned!.status).toBe('abandoned');
    expect(abandoned!.close_reason).toBe('Test abandon reason');
  });

  // INVARIANT: RemoteStorage correctly proxies metadata operations.
  test('task metadata set and get', async () => {
    const remote = await makeRemoteStorage();
    const task = await remote.createTask('Metadata test');

    await remote.updateTaskMetadata(task.id, 'test_key', 'test_value');
    const value = await remote.getTaskMetadata(task.id, 'test_key');
    expect(value).toBe('test_value');
  });

  // INVARIANT: RemoteStorage correctly proxies getStatusHistory.
  test('getStatusHistory returns status changes', async () => {
    const remote = await makeRemoteStorage();
    const task = await remote.createTask('Status history test');

    const history = await remote.getStatusHistory(task.id);
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].status).toBe('backlog');
  });

  // INVARIANT: RemoteStorage correctly proxies the tag methods (add/remove/
  // history) through the daemon, including actor attribution.
  test('addTaskTag / removeTaskTag / getTagHistory round-trip through RPC', async () => {
    const remote = await makeRemoteStorage();
    const task = await remote.createTask('Tag proxy test');

    // Add normalizes and returns the updated task.
    const tagged = await remote.addTaskTag(task.id, '[Onboarding]', 'builder');
    expect(tagged.tags).toEqual(['onboarding']);

    // Remove returns the task with the tag gone.
    const untagged = await remote.removeTaskTag(task.id, 'onboarding', 'builder');
    expect(untagged.tags).toEqual([]);

    // History is append-only and actor-attributed.
    const history = await remote.getTagHistory(task.id);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ tag: 'onboarding', action: 'tag', actor: 'builder' });
    expect(history[1]).toMatchObject({ tag: 'onboarding', action: 'untag', actor: 'builder' });
  });

  // INVARIANT: Void-returning storage methods work through RPC.
  // The daemon must handle undefined returns gracefully (normalize to null).
  test('void methods work without errors', async () => {
    const remote = await makeRemoteStorage();
    const task = await remote.createTask('Void method test');

    // These all return void — should not throw
    await remote.updateTaskGoal(task.id, 'New goal');
    await remote.updateTaskModel(task.id, 'claude-sonnet-4-5-20250929');
    await remote.updateTaskType(task.id, 'fix');
  });
});
