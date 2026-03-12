/**
 * E2E tests for `lazy daemon` command.
 *
 * Tests the daemon lifecycle: start, status, stop, restart.
 * Uses isolated socket paths to avoid conflicting with a real daemon.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import {
  readPid,
  readToken,
  checkDaemonHealth,
  requestShutdown,
  cleanupStaleFiles,
  acquireStartLock,
  releaseStartLock,
} from '../../src/daemon/lifecycle';
import { getStartLockPath } from '../../src/daemon/paths';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';
import { openProjectStorage } from '../../src/daemon/rpc-handlers';

describe('lazy daemon', () => {
  describe('server module (unit-level)', () => {
    let daemon: RunningDaemon;
    let tmpDir: string;
    let socketPath: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'lazy-daemon-test-'));
      socketPath = join(tmpDir, 'test.sock');
    });

    afterEach(async () => {
      if (daemon) {
        daemon.stop();
      }
      await rm(tmpDir, { recursive: true, force: true });
    });

    // INVARIANT: Daemon server binds to unix socket and responds to health checks.
    // This is the foundation for all daemon functionality — if the socket doesn't
    // work, nothing else (CLI pass-through, MCP proxy, auto-start) will work.
    test('starts server on unix socket and responds to health check', async () => {
      daemon = startDaemonServer({ socketPath, token: 'test-token-123' });

      const resp = await fetch('http://localhost/daemon/status', {
        unix: socketPath,
        headers: { 'Authorization': 'Bearer test-token-123' },
      } as any);

      expect(resp.ok).toBe(true);
      const data = await resp.json() as any;
      expect(data.status).toBe('running');
      expect(data.pid).toBe(process.pid);
      expect(typeof data.uptime).toBe('number');
    });

    // INVARIANT: All daemon endpoints require bearer token authentication.
    // Without auth, any local process could control the daemon.
    test('rejects requests without valid bearer token', async () => {
      daemon = startDaemonServer({ socketPath, token: 'test-token-123' });

      // No auth header
      const resp1 = await fetch('http://localhost/daemon/status', {
        unix: socketPath,
      } as any);
      expect(resp1.status).toBe(401);

      // Wrong token
      const resp2 = await fetch('http://localhost/daemon/status', {
        unix: socketPath,
        headers: { 'Authorization': 'Bearer wrong-token' },
      } as any);
      expect(resp2.status).toBe(401);
    });

    // INVARIANT: Unknown routes return 404, not 500 or silent success.
    // Predictable error handling is essential for debugging.
    test('returns 404 for unknown routes', async () => {
      daemon = startDaemonServer({ socketPath, token: 'test-token-123' });

      const resp = await fetch('http://localhost/unknown/path', {
        unix: socketPath,
        headers: { 'Authorization': 'Bearer test-token-123' },
      } as any);

      expect(resp.status).toBe(404);
    });

    // INVARIANT: Shutdown endpoint responds before stopping the server.
    // The CLI needs to know the shutdown was accepted before the connection drops.
    test('shutdown endpoint responds with ok', async () => {
      daemon = startDaemonServer({ socketPath, token: 'test-token-123' });

      const resp = await fetch('http://localhost/daemon/shutdown', {
        method: 'POST',
        unix: socketPath,
        headers: { 'Authorization': 'Bearer test-token-123' },
      } as any);

      expect(resp.ok).toBe(true);
      const data = await resp.json() as any;
      expect(data.ok).toBe(true);

      // Manually stop since shutdown schedules async exit
      daemon.stop();
    });
  });

  describe('lifecycle module', () => {
    let originalHome: string | undefined;
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'lazy-daemon-lifecycle-'));
      originalHome = process.env.HOME;
      process.env.HOME = tmpDir;
    });

    afterEach(async () => {
      process.env.HOME = originalHome;
      await rm(tmpDir, { recursive: true, force: true });
    });

    // INVARIANT: readPid returns null when no PID file exists.
    // This is the base case for liveness detection — "not running".
    test('readPid returns null when no PID file', () => {
      const pid = readPid();
      expect(pid).toBeNull();
    });

    // INVARIANT: cleanupStaleFiles removes PID and socket files.
    // When the daemon crashes, stale files must be cleaned up before restart.
    test('cleanupStaleFiles removes daemon files', async () => {
      const daemonDir = join(tmpDir, '.lazy', 'daemon');
      const { mkdirSync, writeFileSync } = await import('fs');
      mkdirSync(daemonDir, { recursive: true });
      writeFileSync(join(daemonDir, 'lazy.pid'), '12345');
      writeFileSync(join(daemonDir, 'lazy.sock'), 'dummy');

      cleanupStaleFiles();

      expect(existsSync(join(daemonDir, 'lazy.pid'))).toBe(false);
      expect(existsSync(join(daemonDir, 'lazy.sock'))).toBe(false);
    });

    // INVARIANT: checkDaemonHealth returns running=false when no daemon exists.
    // CLI auto-start depends on this to decide whether to fork a daemon.
    test('checkDaemonHealth returns not running when no daemon', async () => {
      const status = await checkDaemonHealth();
      expect(status.running).toBe(false);
    });

    // INVARIANT: acquireStartLock serializes daemon startup.
    // Without this, concurrent CLI commands can both try to spawn a daemon,
    // leading to duplicate processes or PID file corruption.
    test('acquireStartLock returns true when no lock exists', () => {
      expect(acquireStartLock()).toBe(true);
      releaseStartLock();
    });

    // INVARIANT: Only one process can hold the startup lock at a time.
    // The second caller must wait for the first to finish.
    test('acquireStartLock returns false when lock already held', () => {
      expect(acquireStartLock()).toBe(true);
      expect(acquireStartLock()).toBe(false);
      releaseStartLock();
    });

    // INVARIANT: releaseStartLock removes the lock file so subsequent
    // starts can proceed.
    test('releaseStartLock allows re-acquisition', () => {
      expect(acquireStartLock()).toBe(true);
      releaseStartLock();
      expect(acquireStartLock()).toBe(true);
      releaseStartLock();
    });

    // INVARIANT: Stale locks (from crashed starters) are cleaned up
    // so that daemon startup isn't permanently blocked.
    test('acquireStartLock removes stale lock older than 30s', async () => {
      const { mkdirSync, writeFileSync, utimesSync } = await import('fs');
      const lockPath = getStartLockPath();
      mkdirSync(join(tmpDir, '.lazy', 'daemon'), { recursive: true });
      writeFileSync(lockPath, '99999');
      // Set mtime to 60 seconds ago (well past the 30s threshold)
      const past = new Date(Date.now() - 60_000);
      utimesSync(lockPath, past, past);

      // Should detect stale lock, remove it, and acquire
      expect(acquireStartLock()).toBe(true);
      releaseStartLock();
    });

    // INVARIANT: Non-stale locks are respected — prevents race condition.
    test('acquireStartLock respects recent lock from another process', async () => {
      const { mkdirSync, writeFileSync } = await import('fs');
      const lockPath = getStartLockPath();
      mkdirSync(join(tmpDir, '.lazy', 'daemon'), { recursive: true });
      writeFileSync(lockPath, '99999');
      // Lock was just created (mtime is now) — should NOT be considered stale

      expect(acquireStartLock()).toBe(false);
      releaseStartLock();
    });
  });

  describe('CLI command', () => {
    let ctx: TestContext;

    beforeEach(async () => {
      ctx = await setupTestLazy();
    });

    afterEach(async () => {
      await ctx.cleanup();
    });

    // INVARIANT: `lazy daemon` without subcommand shows usage help.
    // Consistent with how other compound commands work.
    test('shows usage when no subcommand given', async () => {
      const result = await ctx.lazy(['daemon']);
      expectSuccess(result);
      expectOutput(result, 'Usage: lazy daemon');
    });

    test('shows usage with --help flag', async () => {
      const result = await ctx.lazy(['daemon', '--help']);
      expectSuccess(result);
      expectOutput(result, 'Usage: lazy daemon');
    });

    // INVARIANT: `lazy daemon status` reports "not running" when no daemon exists.
    // Users need clear status feedback to understand the system state.
    test('status reports not running when daemon is not active', async () => {
      const result = await ctx.lazy(['daemon', 'status'], {
        env: { HOME: ctx.root, LAZY_NO_DAEMON: '1' },
      });
      expectSuccess(result);
      expectOutput(result, 'not running');
    });

    // INVARIANT: `lazy daemon stop` is a no-op when daemon is not running.
    // Idempotent operations prevent user confusion and script errors.
    test('stop is a no-op when daemon is not running', async () => {
      const result = await ctx.lazy(['daemon', 'stop'], {
        env: { HOME: ctx.root, LAZY_NO_DAEMON: '1' },
      });
      expectSuccess(result);
      expectOutput(result, 'not running');
    });

    test('rejects unknown subcommand', async () => {
      const result = await ctx.lazy(['daemon', 'invalid']);
      expectFailure(result);
      expectError(result, 'Unknown daemon subcommand');
    });
  });

  describe('daemon start/stop lifecycle (integration)', () => {
    let tmpDir: string;
    let socketPath: string;
    let daemon: RunningDaemon;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'lazy-daemon-integ-'));
      socketPath = join(tmpDir, 'lazy.sock');
    });

    afterEach(async () => {
      if (daemon) {
        try { daemon.stop(); } catch { /* may already be stopped */ }
      }
      await rm(tmpDir, { recursive: true, force: true });
    });

    // INVARIANT: Full start → health check → stop cycle works end-to-end.
    // This is the core lifecycle that all daemon features depend on.
    test('start, health check, and stop cycle works', async () => {
      // Start
      daemon = startDaemonServer({ socketPath, token: 'lifecycle-token' });

      // Health check
      const resp = await fetch('http://localhost/daemon/status', {
        unix: socketPath,
        headers: { 'Authorization': 'Bearer lifecycle-token' },
      } as any);
      expect(resp.ok).toBe(true);
      const data = await resp.json() as any;
      expect(data.status).toBe('running');

      // Stop
      daemon.stop();

      // Verify socket is cleaned up
      // Note: stop() calls cleanupStaleFiles which removes PID and socket
    });

    // INVARIANT: Daemon reports increasing uptime over time.
    // This confirms the daemon is actually a persistent process, not restarting.
    test('uptime increases between health checks', async () => {
      daemon = startDaemonServer({ socketPath, token: 'uptime-token' });

      const resp1 = await fetch('http://localhost/daemon/status', {
        unix: socketPath,
        headers: { 'Authorization': 'Bearer uptime-token' },
      } as any);
      const data1 = await resp1.json() as any;

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 50));

      const resp2 = await fetch('http://localhost/daemon/status', {
        unix: socketPath,
        headers: { 'Authorization': 'Bearer uptime-token' },
      } as any);
      const data2 = await resp2.json() as any;

      expect(data2.uptime).toBeGreaterThan(data1.uptime);
    });
  });

  describe('RPC pass-through', () => {
    let daemon: RunningDaemon;
    let ctx: TestContext;
    let tmpDir: string;
    let socketPath: string;
    let token: string;

    beforeEach(async () => {
      ctx = await setupTestLazy();
      tmpDir = await mkdtemp(join(tmpdir(), 'lazy-daemon-rpc-'));
      socketPath = join(tmpDir, 'rpc-test.sock');
      token = 'rpc-test-token';
      daemon = startDaemonServer({ socketPath, token });
    });

    afterEach(async () => {
      if (daemon) {
        try { daemon.stop(); } catch { /* may already be stopped */ }
      }
      await ctx.cleanup();
      await rm(tmpDir, { recursive: true, force: true });
    });

    async function rpc(command: string, params: Record<string, unknown> = {}): Promise<any> {
      const response = await fetch(`http://localhost/rpc/${command}`, {
        method: 'POST',
        unix: socketPath,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Lazy-Project': ctx.root,
        },
        body: JSON.stringify(params),
      } as any);
      return { status: response.status, data: await response.json() };
    }

    // INVARIANT: RPC endpoints require the X-Lazy-Project header.
    // Without it, the daemon can't open storage for the correct project.
    test('rejects RPC without X-Lazy-Project header', async () => {
      const response = await fetch('http://localhost/rpc/list', {
        method: 'POST',
        unix: socketPath,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      } as any);
      expect(response.status).toBe(400);
      const data = await response.json() as any;
      expect(data.error).toContain('X-Lazy-Project');
    });

    // INVARIANT: Unknown RPC commands return 404.
    test('returns 404 for unknown RPC command', async () => {
      const { status, data } = await rpc('nonexistent');
      expect(status).toBe(404);
      expect(data.error).toContain('Unknown RPC command');
    });

    // INVARIANT: /rpc/list returns a task tree with correct structure.
    // This is the primary read path for the CLI list command.
    test('rpc/list returns task tree', async () => {
      // Create a task so there's something to list
      const taskId = await createTask(ctx, 'Test list via RPC');

      const { status, data } = await rpc('list', { all: true });
      expect(status).toBe(200);
      expect(data.tree).toBeArray();
      expect(data.tree.length).toBeGreaterThan(0);

      // Verify tree node structure
      const node = data.tree[0];
      expect(node.task).toBeDefined();
      expect(node.task.goal).toBeDefined();
      expect(node.turnCount).toBeDefined();
      expect(node.children).toBeArray();
    });

    // INVARIANT: /rpc/list with default params returns only non-terminal tasks.
    test('rpc/list defaults to non-terminal tasks', async () => {
      const taskId = await createTask(ctx, 'Non-terminal test');

      const { status, data } = await rpc('list');
      expect(status).toBe(200);
      // Task is in backlog (non-terminal), should appear
      expect(data.tree.length).toBeGreaterThan(0);
    });

    // INVARIANT: /rpc/blocked returns only blocked tasks.
    test('rpc/blocked returns empty tree when no blocked tasks', async () => {
      const { status, data } = await rpc('blocked');
      expect(status).toBe(200);
      expect(data.tree).toBeArray();
      expect(data.tree.length).toBe(0);
    });

    // INVARIANT: /rpc/active returns only non-terminal tasks with sessions.
    test('rpc/active returns empty tree when no active tasks', async () => {
      const { status, data } = await rpc('active');
      expect(status).toBe(200);
      expect(data.tree).toBeArray();
      expect(data.tree.length).toBe(0);
    });

    // INVARIANT: /rpc/show returns structured task data.
    // The CLI reconstructs TaskShowData from this to render locally.
    test('rpc/show returns task data', async () => {
      const taskId = await createTask(ctx, 'Test show via RPC');

      const { status, data } = await rpc('show', { taskId });
      expect(status).toBe(200);
      expect(data.task).toBeDefined();
      expect(data.task.goal).toBe('Test show via RPC');
      expect(data.turns).toBeArray();
      expect(data.commits).toBeArray();
      expect(data.comments).toBeArray();
      expect(data.children).toBeArray();
      expect(data.childSessions).toBeDefined();
      expect(data.proposals).toBeArray();
    });

    // INVARIANT: /rpc/show returns 404 for unknown tasks.
    test('rpc/show returns 404 for unknown task', async () => {
      const { status, data } = await rpc('show', { taskId: 'nonexistent-00' });
      expect(status).toBe(404);
      expect(data.error).toContain('not found');
    });

    // INVARIANT: /rpc/show returns 400 when taskId is missing.
    test('rpc/show returns 400 when taskId missing', async () => {
      const { status, data } = await rpc('show', {});
      expect(status).toBe(400);
      expect(data.error).toContain('taskId');
    });

    // INVARIANT: /rpc/search returns matching results.
    // Search is one of the most latency-sensitive commands — daemon routing helps.
    test('rpc/search returns results', async () => {
      await createTask(ctx, 'Searchable daemon test task');

      const { status, data } = await rpc('search', { query: 'daemon' });
      expect(status).toBe(200);
      expect(data.query).toBe('daemon');
      expect(data.results).toBeArray();
      expect(data.results.length).toBeGreaterThan(0);
    });

    // INVARIANT: /rpc/search returns 400 when query is missing.
    test('rpc/search returns 400 when query missing', async () => {
      const { status, data } = await rpc('search', {});
      expect(status).toBe(400);
      expect(data.error).toContain('query');
    });

    // INVARIANT: /rpc/diff returns 400 when task has no session.
    test('rpc/diff returns error for task without session', async () => {
      const taskId = await createTask(ctx, 'No session task');
      const { status, data } = await rpc('diff', { taskId });
      expect(status).toBe(400);
      expect(data.error).toContain('no session');
    });

    // INVARIANT: /rpc/diff returns 400 when taskId is missing.
    test('rpc/diff returns 400 when taskId missing', async () => {
      const { status, data } = await rpc('diff', {});
      expect(status).toBe(400);
      expect(data.error).toContain('taskId');
    });

    // INVARIANT: /rpc/wait returns immediately for non-working tasks.
    // No polling needed when task is already in a terminal or blocked state.
    test('rpc/wait returns immediately for non-working task', async () => {
      const taskId = await createTask(ctx, 'Non-working wait test');

      const { status, data } = await rpc('wait', { taskId, timeout: 2 });
      expect(status).toBe(200);
      // Task is in 'backlog' status (not 'working'), should return immediately
      expect(data.task_id).toBeDefined();
      expect(data.status).not.toBe('working');
      expect(data.timed_out).toBe(false);
    });

    // INVARIANT: /rpc/wait returns 400 when taskId is missing.
    test('rpc/wait returns 400 when taskId missing', async () => {
      const { status, data } = await rpc('wait', {});
      expect(status).toBe(400);
      expect(data.error).toContain('taskId');
    });

    // INVARIANT: /rpc/wait returns 404 for unknown tasks.
    test('rpc/wait returns 404 for unknown task', async () => {
      const { status, data } = await rpc('wait', { taskId: 'nonexistent-00' });
      expect(status).toBe(404);
      expect(data.error).toContain('not found');
    });
  });

  describe('multi-project routing', () => {
    let daemon: RunningDaemon;
    let ctxA: TestContext;
    let ctxB: TestContext;
    let tmpDir: string;
    let socketPath: string;
    let token: string;

    beforeEach(async () => {
      ctxA = await setupTestLazy();
      ctxB = await setupTestLazy();
      tmpDir = await mkdtemp(join(tmpdir(), 'lazy-daemon-multi-'));
      socketPath = join(tmpDir, 'multi-test.sock');
      token = 'multi-project-token';
      daemon = startDaemonServer({ socketPath, token });
    });

    afterEach(async () => {
      if (daemon) {
        try { daemon.stop(); } catch { /* may already be stopped */ }
      }
      await ctxA.cleanup();
      await ctxB.cleanup();
      await rm(tmpDir, { recursive: true, force: true });
    });

    function rpcForProject(project: string, command: string, params: Record<string, unknown> = {}): Promise<any> {
      return fetch(`http://localhost/rpc/${command}`, {
        method: 'POST',
        unix: socketPath,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Lazy-Project': project,
        },
        body: JSON.stringify(params),
      } as any).then(async (response) => ({
        status: response.status,
        data: await response.json(),
      }));
    }

    // INVARIANT: The daemon routes requests to the correct project based on
    // X-Lazy-Project header, not its own process.cwd(). Without this,
    // whichever project spawned the daemon "captures" all subsequent requests.
    test('returns different tasks for different projects', async () => {
      // Create distinct tasks in each project
      const taskIdA = await createTask(ctxA, 'Task in project Alpha');
      const taskIdB = await createTask(ctxB, 'Task in project Beta');

      // Query project A
      const resultA = await rpcForProject(ctxA.root, 'list', { all: true });
      expect(resultA.status).toBe(200);
      const goalsA = resultA.data.tree.map((n: any) => n.task.goal);
      expect(goalsA).toContain('Task in project Alpha');
      expect(goalsA).not.toContain('Task in project Beta');

      // Query project B
      const resultB = await rpcForProject(ctxB.root, 'list', { all: true });
      expect(resultB.status).toBe(200);
      const goalsB = resultB.data.tree.map((n: any) => n.task.goal);
      expect(goalsB).toContain('Task in project Beta');
      expect(goalsB).not.toContain('Task in project Alpha');
    });

    // INVARIANT: show returns the correct task from the correct project.
    test('show returns correct task from correct project', async () => {
      const taskIdA = await createTask(ctxA, 'Alpha show test');
      const taskIdB = await createTask(ctxB, 'Beta show test');

      const showA = await rpcForProject(ctxA.root, 'show', { taskId: taskIdA });
      expect(showA.status).toBe(200);
      expect(showA.data.task.goal).toBe('Alpha show test');

      const showB = await rpcForProject(ctxB.root, 'show', { taskId: taskIdB });
      expect(showB.status).toBe(200);
      expect(showB.data.task.goal).toBe('Beta show test');
    });

    // INVARIANT: search scopes results to the requested project.
    test('search scopes results to the requested project', async () => {
      await createTask(ctxA, 'Unique alpha unicorn task');
      await createTask(ctxB, 'Unique beta dragon task');

      const searchA = await rpcForProject(ctxA.root, 'search', { query: 'unicorn' });
      expect(searchA.status).toBe(200);
      expect(searchA.data.results.length).toBeGreaterThan(0);

      const searchB = await rpcForProject(ctxB.root, 'search', { query: 'unicorn' });
      expect(searchB.status).toBe(200);
      expect(searchB.data.results.length).toBe(0);
    });

    // INVARIANT: A task from project A is not found in project B.
    test('show returns 404 for task ID from wrong project', async () => {
      const taskIdA = await createTask(ctxA, 'Alpha only task');

      // Task exists in project A
      const showA = await rpcForProject(ctxA.root, 'show', { taskId: taskIdA });
      expect(showA.status).toBe(200);

      // Same task ID does not exist in project B
      const showB = await rpcForProject(ctxB.root, 'show', { taskId: taskIdA });
      expect(showB.status).toBe(404);
    });
  });

  describe('reconcile loop', () => {
    let daemon: RunningDaemon;
    let ctx: TestContext;
    let tmpDir: string;
    let socketPath: string;
    let token: string;

    beforeEach(async () => {
      // Set LAZY_TEST so the reconcile grace period is 0 (evaluated at call time)
      process.env.LAZY_TEST = '1';
      ctx = await setupTestLazy();
      tmpDir = await mkdtemp(join(tmpdir(), 'lazy-daemon-reconcile-'));
      socketPath = join(tmpDir, 'reconcile-test.sock');
      token = 'reconcile-test-token';
      // Use a short reconcile interval for tests
      daemon = startDaemonServer({ socketPath, token, reconcileIntervalSeconds: 1 });
    });

    afterEach(async () => {
      if (daemon) {
        try { daemon.stop(); } catch { /* may already be stopped */ }
      }
      await ctx.cleanup();
      await rm(tmpDir, { recursive: true, force: true });
    });

    async function rpc(command: string, params: Record<string, unknown> = {}): Promise<any> {
      const response = await fetch(`http://localhost/rpc/${command}`, {
        method: 'POST',
        unix: socketPath,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Lazy-Project': ctx.root,
        },
        body: JSON.stringify(params),
      } as any);
      return { status: response.status, data: await response.json() };
    }

    // INVARIANT: RPC requests register the project for background reconciliation.
    // Without this, the daemon wouldn't know which projects to reconcile.
    test('RPC request registers project in activeProjects', async () => {
      expect(daemon.activeProjects.size).toBe(0);

      await rpc('list');

      expect(daemon.activeProjects.has(ctx.root)).toBe(true);
    });

    // INVARIANT: The daemon reconcile loop transitions working tasks with no
    // running container to interrupted. Without this, crashed containers leave
    // tasks stuck in 'working' forever.
    test('reconcile loop moves working task with no container to interrupted', async () => {
      // 1. Create a task and set it to 'working' with a session BEFORE registering
      //    the project with the daemon, so the reconcile loop sees it on its first tick.
      const shortTaskId = await createTask(ctx, 'Reconcile test task');

      const storage = await openProjectStorage(ctx.root);
      const allTasks = await storage.listTasks();
      const task = allTasks.find(t => t.id.startsWith(shortTaskId));
      expect(task).toBeDefined();

      const gitResult = ctx.git('rev-parse', 'HEAD');
      const startSha = gitResult.stdout.trim();

      await storage.createSession(task!.id, 'test-agent', `lazy/fix.${shortTaskId}`, startSha);
      await storage.updateTaskStatus(task!.id, 'working', 'system');
      await storage.close();

      // 2. Register the project via RPC. The reconcile loop will pick it up
      //    on its next tick and see the working task with no container.
      await rpc('list');
      expect(daemon.activeProjects.has(ctx.root)).toBe(true);

      // 3. Poll until the reconcile loop transitions the task to 'interrupted'.
      //    With 1s interval, this typically takes 1-2 ticks.
      //    WORKING_GRACE_PERIOD_MS is 0 in tests.
      let finalStatus = 'working';
      for (let i = 0; i < 8; i++) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
        const { status, data } = await rpc('show', { taskId: shortTaskId });
        expect(status).toBe(200);
        finalStatus = data.task.status;
        if (finalStatus === 'interrupted') break;
      }

      // 4. Verify the task moved to 'interrupted'
      expect(finalStatus).toBe('interrupted');
    }, 15_000); // 15s timeout for this test
  });
});
