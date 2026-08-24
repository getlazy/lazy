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
import { formatDashboardUrl } from '../../src/daemon/dashboard-url';
import {
  readPid,
  readToken,
  checkDaemonHealth,
  isDaemonRunning,
  requestShutdown,
  cleanupStaleFiles,
  acquireStartLock,
  releaseStartLock,
} from '../../src/daemon/lifecycle';
import { getStartLockPath, getDaemonDir } from '../../src/daemon/paths';
import { DEFAULT_SERVER_BIND } from '../../src/config/constants';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTaskBeforeDaemon } from '../helpers/fixtures';
import { openProjectStorage } from '../../src/daemon/rpc-handlers';
import { slowSuiteSkipped } from '../helpers/slow-suite';
import { makeDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { pinConfig } from '../helpers/pin-config';
import { isolateInProcessDaemonEnv } from '../helpers/in-process-daemon';
import { DEAD_PID } from '../helpers/dead-pid';

/**
 * The address a port squatter must bind to actually block the daemon.
 *
 * Several tests below force a web-bind failure by occupying the port the daemon
 * is about to take. The daemon binds a SPECIFIC address (DEFAULT_SERVER_BIND,
 * 127.0.0.1) — so a squatter MUST bind that same address. `Bun.serve` defaults
 * to the wildcard (`::`), and a wildcard listener only reliably blocks a later
 * specific bind on Linux: on macOS/BSD, SO_REUSEADDR permits binding a more
 * specific address over an existing wildcard, so the daemon bound successfully
 * and every "the bind must fail" assertion in this file failed on a Mac while
 * passing in Linux CI. Squat the exact bind host, never the wildcard.
 */
const SQUAT_HOST = DEFAULT_SERVER_BIND;

/**
 * Where a test that chdir()s puts the process back.
 *
 * Not `process.cwd()`: restoring to whatever the cwd happened to be when a test
 * started is unsafe — an earlier suite may have left the process inside a temp
 * project that has since been removed, and chdir()ing back to a deleted path
 * throws ENOENT and fails an otherwise-passing test (that cascade cost this file
 * three tests). Not the repo root either: config and storage resolve from cwd, so
 * landing there makes later cwd-sensitive tests pick up lazy's OWN lazy.toml.
 * The system temp dir is both guaranteed to exist and free of any lazy project.
 */
const STABLE_CWD = tmpdir();

/**
 * Rewrite a test project's `[server] port` to a port the OS reports free, so a
 * real `lazy daemon start` does not depend on the shared 26024+ window being
 * available on the machine running the suite.
 *
 * The generated lazy.toml already has a `[server]` section with `port = 26024`;
 * appending a second one would be a duplicate key, so the existing line is
 * rewritten in place (same reasoning as `forceBindFailure` below). A
 * non-default configured port is authoritative over the persisted one, so this
 * genuinely steers the bind.
 */
async function pinFreeServerPort(projectRoot: string): Promise<number> {
  const probe = Bun.serve({ hostname: SQUAT_HOST, port: 0, fetch: () => new Response('probe') });
  const port = probe.port!;
  probe.stop(true);

  const configPath = join(projectRoot, 'lazy.toml');
  const existing = await readFile(configPath, 'utf-8');
  const updated = existing.replace(/^port\s*=\s*\d+/m, `port = ${port}`);
  if (updated === existing) {
    throw new Error('pinFreeServerPort: failed to rewrite port in lazy.toml');
  }
  await writeFile(configPath, updated);
  return port;
}

// Slow suite (>300s per file): opt in with LAZY_SLOW_TESTS=1. Gating only —
// no test content is weakened or removed.

// This suite runs a daemon IN-PROCESS; keep the LAZY_IS_DAEMON flag that
// startDaemonServer() sets process-wide from leaking into later test files.
isolateInProcessDaemonEnv();

describe.skipIf(slowSuiteSkipped('lazy daemon'))('lazy daemon', () => {
  describe('server module (unit-level)', () => {
    let daemon: RunningDaemon;
    let ctx: TestContext;
    let tmpDir: string;
    let socketPath: string;

    beforeEach(async () => {
      ctx = await setupTestLazy();
      tmpDir = await mkdtemp(join(tmpdir(), 'lazy-daemon-test-'));
      socketPath = join(tmpDir, 'test.sock');
    });

    afterEach(async () => {
      if (daemon) {
        await daemon.stop();
      }
      await ctx.cleanup();
      await rm(tmpDir, { recursive: true, force: true });
    });

    // INVARIANT: Daemon server binds to unix socket and responds to health checks.
    // This is the foundation for all daemon functionality — if the socket doesn't
    // work, nothing else (CLI pass-through, MCP proxy, auto-start) will work.
    test('starts server on unix socket and responds to health check', async () => {
      daemon = await startDaemonServer({ socketPath, token: 'test-token-123', projectRoot: ctx.root });

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
      daemon = await startDaemonServer({ socketPath, token: 'test-token-123', projectRoot: ctx.root });

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
      daemon = await startDaemonServer({ socketPath, token: 'test-token-123', projectRoot: ctx.root });

      const resp = await fetch('http://localhost/unknown/path', {
        unix: socketPath,
        headers: { 'Authorization': 'Bearer test-token-123' },
      } as any);

      expect(resp.status).toBe(404);
    });

    // INVARIANT: Shutdown endpoint responds before stopping the server.
    // The CLI needs to know the shutdown was accepted before the connection drops.
    test('shutdown endpoint responds with ok', async () => {
      daemon = await startDaemonServer({ socketPath, token: 'test-token-123', projectRoot: ctx.root });

      const resp = await fetch('http://localhost/daemon/shutdown', {
        method: 'POST',
        unix: socketPath,
        headers: { 'Authorization': 'Bearer test-token-123' },
      } as any);

      expect(resp.ok).toBe(true);
      const data = await resp.json() as any;
      expect(data.ok).toBe(true);

      // Manually stop since shutdown schedules async exit
      await daemon.stop();
    });

    // INVARIANT: a [proxy] startup failure is a CONTROLLED startup error, not an
    // unhandled rejection that half-starts the daemon. When [proxy] is configured
    // but the proxy cannot bind (here: its port is already taken), startDaemonServer
    // must reject with an actionable message AND tear down the partial daemon so no
    // stale socket/lock is left behind. Regression guard for the live-testing crash
    // where a failed proxy start took the whole daemon down ~6s after boot.
    test('proxy startup failure is a controlled error that tears down the daemon', async () => {
      // Occupy a port so the proxy's bind fails with EADDRINUSE.
      const squatter = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') });
      const takenPort = squatter.port;
      try {
        // Enable the proxy on the already-taken port.
        const configPath = join(ctx.root, 'lazy.toml');
        const original = await readFile(configPath, 'utf-8');
        await writeFile(configPath, `${original}\n[proxy]\nport = ${takenPort}\n`);

        await expect(
          startDaemonServer({ socketPath, token: 'proxy-fail-token', projectRoot: ctx.root }),
        ).rejects.toThrow(/failed to start the \[proxy\] server/i);

        // Controlled teardown: no running daemon, no stale unix socket.
        expect(existsSync(socketPath)).toBe(false);
        expect(await isDaemonRunning(ctx.root)).toBe(false);
      } finally {
        squatter.stop();
      }
    });
  });

  describe('lifecycle module', () => {
    let originalHome: string | undefined;
    let tmpDir: string;
    /** Fake project root — lifecycle functions derive daemon dir from this */
    let fakeProjectRoot: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'lazy-daemon-lifecycle-'));
      originalHome = process.env.HOME;
      process.env.HOME = tmpDir;
      // Use a fake project root so that getDaemonDir(fakeProjectRoot) resolves
      // under $HOME/.lazy/daemon/<slug>/
      fakeProjectRoot = '/fake/project/root';
    });

    afterEach(async () => {
      process.env.HOME = originalHome;
      await rm(tmpDir, { recursive: true, force: true });
    });

    // INVARIANT: readPid returns null when no PID file exists.
    // This is the base case for liveness detection — "not running".
    test('readPid returns null when no PID file', () => {
      const pid = readPid(fakeProjectRoot);
      expect(pid).toBeNull();
    });

    // INVARIANT: cleanupStaleFiles removes PID and socket files that are
    // genuinely stale — no lock holder and the recorded PID dead. Those two
    // conditions are the whole contract: the same call must REFUSE while a live
    // daemon owns the directory (see test/e2e/daemon-cleanup-ownership.test.ts),
    // because deleting a running daemon's files wedges every CLI command
    // against a daemon that is running fine. The PID below must therefore be a
    // definitely-dead one — an arbitrary low PID like 12345 can be a live
    // process on the host, which would make the guard refuse and this test flap.
    test('cleanupStaleFiles removes daemon files', async () => {
      const daemonDir = getDaemonDir(fakeProjectRoot);
      const { mkdirSync, writeFileSync } = await import('fs');
      mkdirSync(daemonDir, { recursive: true });
      writeFileSync(join(daemonDir, 'lazy.pid'), String(DEAD_PID));
      writeFileSync(join(daemonDir, 'lazy.sock'), 'dummy');

      expect(cleanupStaleFiles(fakeProjectRoot)).toBe('removed');

      expect(existsSync(join(daemonDir, 'lazy.pid'))).toBe(false);
      expect(existsSync(join(daemonDir, 'lazy.sock'))).toBe(false);
    });

    // INVARIANT: checkDaemonHealth returns running=false when no daemon exists.
    // CLI auto-start depends on this to decide whether to fork a daemon.
    test('checkDaemonHealth returns not running when no daemon', async () => {
      const status = await checkDaemonHealth(fakeProjectRoot);
      expect(status.running).toBe(false);
    });

    // INVARIANT: acquireStartLock serializes daemon startup.
    // Without this, concurrent CLI commands can both try to spawn a daemon,
    // leading to duplicate processes or PID file corruption.
    test('acquireStartLock returns true when no lock exists', () => {
      expect(acquireStartLock(fakeProjectRoot)).toBe(true);
      releaseStartLock(fakeProjectRoot);
    });

    // INVARIANT: Only one process can hold the startup lock at a time.
    // The second caller must wait for the first to finish.
    test('acquireStartLock returns false when lock already held', () => {
      expect(acquireStartLock(fakeProjectRoot)).toBe(true);
      expect(acquireStartLock(fakeProjectRoot)).toBe(false);
      releaseStartLock(fakeProjectRoot);
    });

    // INVARIANT: releaseStartLock removes the lock file so subsequent
    // starts can proceed.
    test('releaseStartLock allows re-acquisition', () => {
      expect(acquireStartLock(fakeProjectRoot)).toBe(true);
      releaseStartLock(fakeProjectRoot);
      expect(acquireStartLock(fakeProjectRoot)).toBe(true);
      releaseStartLock(fakeProjectRoot);
    });

    // INVARIANT: Stale locks (from crashed starters) are cleaned up
    // so that daemon startup isn't permanently blocked.
    test('acquireStartLock removes stale lock older than 30s', async () => {
      const { mkdirSync, writeFileSync, utimesSync } = await import('fs');
      const lockPath = getStartLockPath(fakeProjectRoot);
      mkdirSync(getDaemonDir(fakeProjectRoot), { recursive: true });
      writeFileSync(lockPath, '99999');
      // Set mtime to 60 seconds ago (well past the 30s threshold)
      const past = new Date(Date.now() - 60_000);
      utimesSync(lockPath, past, past);

      // Should detect stale lock, remove it, and acquire
      expect(acquireStartLock(fakeProjectRoot)).toBe(true);
      releaseStartLock(fakeProjectRoot);
    });

    // INVARIANT: Non-stale locks are respected — prevents race condition.
    test('acquireStartLock respects recent lock from another process', async () => {
      const { mkdirSync, writeFileSync } = await import('fs');
      const lockPath = getStartLockPath(fakeProjectRoot);
      mkdirSync(getDaemonDir(fakeProjectRoot), { recursive: true });
      writeFileSync(lockPath, '99999');
      // Lock was just created (mtime is now) — should NOT be considered stale

      expect(acquireStartLock(fakeProjectRoot)).toBe(false);
      releaseStartLock(fakeProjectRoot);
    });

    // INVARIANT: isDaemonRunning returns false when no daemon files exist.
    // Base case — daemon was never started.
    test('isDaemonRunning returns false when no files exist', () => {
      expect(isDaemonRunning(fakeProjectRoot)).toBe(false);
    });

    // INVARIANT: isDaemonRunning returns false when socket exists but PID is dead.
    // This is the crash recovery case — daemon died but left stale files behind.
    // Previously, ensureDaemon and daemonStart only checked file existence, which
    // caused "already running" when the daemon was actually dead.
    test('isDaemonRunning returns false when socket exists but PID is dead (crash recovery)', async () => {
      const { mkdirSync, writeFileSync } = await import('fs');
      const daemonDir = getDaemonDir(fakeProjectRoot);
      mkdirSync(daemonDir, { recursive: true });

      // Simulate crash: socket file, token, and PID file all exist,
      // but the PID points to a dead process.
      writeFileSync(join(daemonDir, 'lazy.sock'), 'stale-socket');
      writeFileSync(join(daemonDir, 'token'), 'stale-token');
      writeFileSync(join(daemonDir, 'lazy.pid'), '999999'); // very likely dead PID

      expect(isDaemonRunning(fakeProjectRoot)).toBe(false);
    });

    // INVARIANT: isDaemonRunning returns false when socket exists but no PID file.
    // PID file missing means we can't verify the process is alive.
    test('isDaemonRunning returns false when socket exists but no PID file', async () => {
      const { mkdirSync, writeFileSync } = await import('fs');
      const daemonDir = getDaemonDir(fakeProjectRoot);
      mkdirSync(daemonDir, { recursive: true });

      writeFileSync(join(daemonDir, 'lazy.sock'), 'stale-socket');
      writeFileSync(join(daemonDir, 'token'), 'some-token');
      // No PID file

      expect(isDaemonRunning(fakeProjectRoot)).toBe(false);
    });

    // INVARIANT: isDaemonRunning returns false when socket exists but no token.
    // Without a token, the daemon can't be authenticated.
    test('isDaemonRunning returns false when socket exists but no token', async () => {
      const { mkdirSync, writeFileSync } = await import('fs');
      const daemonDir = getDaemonDir(fakeProjectRoot);
      mkdirSync(daemonDir, { recursive: true });

      writeFileSync(join(daemonDir, 'lazy.sock'), 'stale-socket');
      writeFileSync(join(daemonDir, 'lazy.pid'), String(process.pid));
      // No token file

      expect(isDaemonRunning(fakeProjectRoot)).toBe(false);
    });

    // INVARIANT: isDaemonRunning returns true when all signals are present
    // and the PID is alive (using current process PID as a known-alive process).
    test('isDaemonRunning returns true when socket, token, and PID are alive', async () => {
      const { mkdirSync, writeFileSync } = await import('fs');
      const daemonDir = getDaemonDir(fakeProjectRoot);
      mkdirSync(daemonDir, { recursive: true });

      writeFileSync(join(daemonDir, 'lazy.sock'), 'socket-placeholder');
      writeFileSync(join(daemonDir, 'token'), 'test-token');
      writeFileSync(join(daemonDir, 'lazy.pid'), String(process.pid)); // current process is alive

      expect(isDaemonRunning(fakeProjectRoot)).toBe(true);
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
      const result = await ctx.lazy(['daemon', 'status']);
      expectSuccess(result);
      expectOutput(result, 'not running');
    });

    // INVARIANT: `lazy daemon stop` is a no-op when daemon is not running.
    // Idempotent operations prevent user confusion and script errors.
    test('stop is a no-op when daemon is not running', async () => {
      const result = await ctx.lazy(['daemon', 'stop']);
      expectSuccess(result);
      expectOutput(result, 'not running');
    });

    test('rejects unknown subcommand', async () => {
      const result = await ctx.lazy(['daemon', 'invalid']);
      expectFailure(result);
      expectError(result, 'Unknown daemon subcommand');
    });

    // INVARIANT: `lazy daemon status` outside a lazy project dir gives a clear error.
    // Users need to know they must be in a project directory.
    test('status errors clearly when run outside a lazy project', async () => {
      const plainDir = await mkdtemp(join(tmpdir(), 'lazy-no-project-'));
      try {
        const ENTRY_PATH = join(__dirname, '../../src/index.ts');
        const proc = Bun.spawn(['bun', 'run', ENTRY_PATH, 'daemon', 'status'], {
          cwd: plainDir,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, LAZY_TEST: '1' },
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(exitCode).not.toBe(0);
        expect(stderr).toContain('not in a lazy project');
      } finally {
        await rm(plainDir, { recursive: true, force: true });
      }
    });
  });

  describe('daemon start/stop lifecycle (integration)', () => {
    let ctx: TestContext;
    let tmpDir: string;
    let socketPath: string;
    let daemon: RunningDaemon;

    beforeEach(async () => {
      ctx = await setupTestLazy();
      tmpDir = await mkdtemp(join(tmpdir(), 'lazy-daemon-integ-'));
      socketPath = join(tmpDir, 'lazy.sock');
    });

    afterEach(async () => {
      if (daemon) {
        try { await daemon.stop(); } catch { /* may already be stopped */ }
      }
      await ctx.cleanup();
      await rm(tmpDir, { recursive: true, force: true });
    });

    // INVARIANT: Full start → health check → stop cycle works end-to-end.
    // This is the core lifecycle that all daemon features depend on.
    test('start, health check, and stop cycle works', async () => {
      // Start
      daemon = await startDaemonServer({ socketPath, token: 'lifecycle-token', projectRoot: ctx.root });

      // Health check
      const resp = await fetch('http://localhost/daemon/status', {
        unix: socketPath,
        headers: { 'Authorization': 'Bearer lifecycle-token' },
      } as any);
      expect(resp.ok).toBe(true);
      const data = await resp.json() as any;
      expect(data.status).toBe('running');

      // Stop
      await daemon.stop();

      // Verify socket is cleaned up
      // Note: stop() calls cleanupOwnDaemonFiles, which removes PID and socket.
      // The owner deletes its own files unconditionally — the ownership guard in
      // cleanupStaleFiles is for OTHER processes, and would refuse here.
    });

    // INVARIANT: Daemon reports increasing uptime over time.
    // This confirms the daemon is actually a persistent process, not restarting.
    test('uptime increases between health checks', async () => {
      daemon = await startDaemonServer({ socketPath, token: 'uptime-token', projectRoot: ctx.root });

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
    let fixtureTaskId: string;

    // A single backlog task, created BEFORE the daemon starts. The daemon holds
    // the project's .storage-lock for its whole lifetime, so a `lazy create`
    // subprocess launched while it is running can NEVER acquire the lock — it
    // burns its retry budget and fails. Every test here that needs a task uses
    // this one. The goal contains "daemon" so the search test matches it.
    const FIXTURE_GOAL = 'Searchable daemon fixture task';

    // A second fixture: a task that HAS a session and is in a terminal status.
    // `wait` refuses a task with no session (nothing to wait for, ever), so the
    // no-session fixture above cannot exercise its immediate-return path. Terminal
    // rather than blocked/backlog so it stays out of /rpc/active and /rpc/blocked,
    // which assert empty trees.
    let settledTaskId: string;

    beforeEach(async () => {
      ctx = await setupTestLazy();
      fixtureTaskId = await createTaskBeforeDaemon(ctx, FIXTURE_GOAL);
      settledTaskId = await createTaskBeforeDaemon(ctx, 'Settled daemon fixture task');
      const setupStorage = await openProjectStorage(ctx.root);
      try {
        const settled = (await setupStorage.listTasks()).find(t => t.id.startsWith(settledTaskId));
        expect(settled).toBeDefined();
        const startSha = ctx.git('rev-parse', 'HEAD').stdout.trim();
        await setupStorage.createSession(settled!.id, 'test-agent', `lazy/fix.${settledTaskId}`, startSha);
        // 'abandoned' is the one terminal status reachable directly from backlog.
        await setupStorage.updateTaskStatus(settled!.id, 'abandoned', 'system');
      } finally {
        await setupStorage.close();
      }
      tmpDir = await mkdtemp(join(tmpdir(), 'lazy-daemon-rpc-'));
      socketPath = join(tmpDir, 'rpc-test.sock');
      token = 'rpc-test-token';
      daemon = await startDaemonServer({ socketPath, token, projectRoot: ctx.root });
    });

    afterEach(async () => {
      if (daemon) {
        try { await daemon.stop(); } catch { /* may already be stopped */ }
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
      const { status, data } = await rpc('list');
      expect(status).toBe(200);
      // The fixture task is in backlog (non-terminal), so it should appear
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
      const { status, data } = await rpc('show', { taskId: fixtureTaskId });
      expect(status).toBe(200);
      expect(data.task).toBeDefined();
      expect(data.task.goal).toBe(FIXTURE_GOAL);
      expect(data.turns).toBeArray();
      expect(data.commits).toBeArray();
      expect(data.comments).toBeArray();
      expect(data.children).toBeArray();
      expect(data.childSessions).toBeDefined();
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
      // The fixture task has never been started, so it has no session.
      const { status, data } = await rpc('diff', { taskId: fixtureTaskId });
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
      const { status, data } = await rpc('wait', { taskId: settledTaskId, timeout: 2 });
      expect(status).toBe(200);
      // Task has a session but is not 'working', so wait returns without polling
      expect(data.task_id).toBeDefined();
      expect(data.status).not.toBe('working');
      expect(data.timed_out).toBe(false);
    });

    // INVARIANT: /rpc/wait refuses a task that was never started. Waiting on a
    // task with no session can never terminate on its own, so the daemon says so
    // instead of reporting "now backlog" behind a bare non-zero exit.
    test('rpc/wait returns 400 for a task with no session', async () => {
      const { status, data } = await rpc('wait', { taskId: fixtureTaskId, timeout: 2 });
      expect(status).toBe(400);
      expect(data.error).toContain('no session');
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

  describe('project mismatch rejection', () => {
    let daemon: RunningDaemon;
    let ctx: TestContext;
    let tmpDir: string;
    let socketPath: string;
    let token: string;

    beforeEach(async () => {
      ctx = await setupTestLazy();
      await createTaskBeforeDaemon(ctx, 'Matching project task');
      tmpDir = await mkdtemp(join(tmpdir(), 'lazy-daemon-mismatch-'));
      socketPath = join(tmpDir, 'mismatch-test.sock');
      token = 'mismatch-token';
      daemon = await startDaemonServer({ socketPath, token, projectRoot: ctx.root });
    });

    afterEach(async () => {
      if (daemon) {
        try { await daemon.stop(); } catch { /* may already be stopped */ }
      }
      await ctx.cleanup();
      await rm(tmpDir, { recursive: true, force: true });
    });

    // INVARIANT: RPC requests for a different project root are rejected with 400.
    // The daemon is per-project — clients for other projects should connect to
    // that project's daemon instead.
    test('rejects RPC for wrong project with 400', async () => {
      const response = await fetch('http://localhost/rpc/list', {
        method: 'POST',
        unix: socketPath,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Lazy-Project': '/some/other/project',
        },
        body: '{}',
      } as any);
      expect(response.status).toBe(400);
      const data = await response.json() as any;
      expect(data.error).toContain('Project mismatch');
    });

    // INVARIANT: MCP requests for a different project are rejected with 400.
    test('rejects MCP for wrong project with 400', async () => {
      const response = await fetch('http://localhost/mcp/task123/toolName', {
        method: 'POST',
        unix: socketPath,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Lazy-Project': '/some/other/project',
        },
        body: '{}',
      } as any);
      expect(response.status).toBe(400);
      const data = await response.json() as any;
      expect(data.error).toContain('Project mismatch');
    });

    // INVARIANT: Requests matching the daemon's project root succeed.
    test('accepts RPC for matching project', async () => {
      const response = await fetch('http://localhost/rpc/list', {
        method: 'POST',
        unix: socketPath,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Lazy-Project': ctx.root,
        },
        body: JSON.stringify({ all: true }),
      } as any);
      expect(response.status).toBe(200);
    });
  });

  describe('per-project isolation', () => {
    let daemonA: RunningDaemon;
    let daemonB: RunningDaemon;
    let ctxA: TestContext;
    let ctxB: TestContext;
    let tmpDir: string;

    beforeEach(async () => {
      ctxA = await setupTestLazy();
      ctxB = await setupTestLazy();
      tmpDir = await mkdtemp(join(tmpdir(), 'lazy-daemon-isolation-'));
    });

    afterEach(async () => {
      if (daemonA) {
        try { await daemonA.stop(); } catch { /* may already be stopped */ }
      }
      if (daemonB) {
        try { await daemonB.stop(); } catch { /* may already be stopped */ }
      }
      await ctxA.cleanup();
      await ctxB.cleanup();
      await rm(tmpDir, { recursive: true, force: true });
    });

    // INVARIANT: Two projects get separate daemon sockets.
    // This is the core guarantee of per-project daemon isolation.
    test('two projects get separate daemon sockets and respond independently', async () => {
      const socketA = join(tmpDir, 'project-a.sock');
      const socketB = join(tmpDir, 'project-b.sock');

      daemonA = await startDaemonServer({ socketPath: socketA, token: 'token-a', projectRoot: ctxA.root });
      daemonB = await startDaemonServer({ socketPath: socketB, token: 'token-b', projectRoot: ctxB.root });

      // Both respond to health checks independently
      const respA = await fetch('http://localhost/daemon/status', {
        unix: socketA,
        headers: { 'Authorization': 'Bearer token-a' },
      } as any);
      expect(respA.ok).toBe(true);

      const respB = await fetch('http://localhost/daemon/status', {
        unix: socketB,
        headers: { 'Authorization': 'Bearer token-b' },
      } as any);
      expect(respB.ok).toBe(true);

      // Stop one daemon, the other should still work
      await daemonA.stop();

      const respB2 = await fetch('http://localhost/daemon/status', {
        unix: socketB,
        headers: { 'Authorization': 'Bearer token-b' },
      } as any);
      expect(respB2.ok).toBe(true);
    });
  });

  describe('reconcile loop', () => {
    let daemon: RunningDaemon;
    let ctx: TestContext;
    let tmpDir: string;
    let socketPath: string;
    let token: string;

    let workingTaskId: string;

    beforeEach(async () => {
      // Set LAZY_TEST so the reconcile grace period is 0 (evaluated at call time)
      process.env.LAZY_TEST = '1';
      ctx = await setupTestLazy();
      tmpDir = await mkdtemp(join(tmpdir(), 'lazy-daemon-reconcile-'));
      socketPath = join(tmpDir, 'reconcile-test.sock');
      token = 'reconcile-test-token';

      // Put the task in 'working' with a session BEFORE the daemon starts: the
      // reconcile loop must see that state on its first tick. openProjectStorage()
      // below carries the same ordering constraint createTaskBeforeDaemon enforces.
      workingTaskId = await createTaskBeforeDaemon(ctx, 'Reconcile test task');
      const storage = await openProjectStorage(ctx.root);
      try {
        const allTasks = await storage.listTasks();
        const task = allTasks.find(t => t.id.startsWith(workingTaskId));
        expect(task).toBeDefined();
        const startSha = ctx.git('rev-parse', 'HEAD').stdout.trim();
        await storage.createSession(task!.id, 'test-agent', `lazy/fix.${workingTaskId}`, startSha);
        await storage.updateTaskStatus(task!.id, 'working', 'system');
      } finally {
        await storage.close();
      }

      // Use a short reconcile interval for tests
      daemon = await startDaemonServer({ socketPath, token, reconcileIntervalSeconds: 1, projectRoot: ctx.root });
    });

    afterEach(async () => {
      if (daemon) {
        try { await daemon.stop(); } catch { /* may already be stopped */ }
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

    // INVARIANT: The daemon knows its project root at startup.
    test('daemon has projectRoot set from startup', async () => {
      expect(daemon.projectRoot).toBe(ctx.root);
    });

    // INVARIANT: The daemon reconcile loop transitions working tasks with no
    // running container to interrupted. Without this, crashed containers leave
    // tasks stuck in 'working' forever.
    test('reconcile loop moves working task with no container to interrupted', async () => {
      // The task is already 'working' with a session (see beforeEach). Trigger an
      // RPC to ensure storage is initialized for the reconcile loop.
      await rpc('list');

      // Poll until the reconcile loop transitions the task to 'interrupted'.
      // With 1s interval, this typically takes 1-2 ticks.
      // WORKING_GRACE_PERIOD_MS is 0 in tests.
      let finalStatus = 'working';
      for (let i = 0; i < 8; i++) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
        const { status, data } = await rpc('show', { taskId: workingTaskId });
        expect(status).toBe(200);
        finalStatus = data.task.status;
        if (finalStatus === 'interrupted') break;
      }

      expect(finalStatus).toBe('interrupted');
    }, 15_000); // 15s timeout for this test
  });

  describe('web binding failure', () => {
    let ctx: TestContext;
    let tmpDir: string;
    let originalBaseDir: string | undefined;
    let squatter: ReturnType<typeof Bun.serve> | undefined;

    beforeEach(async () => {
      process.env.LAZY_TEST = '1';
      ctx = await setupTestLazy();
      // Isolate daemon state (PID, lock, token, socket) from the real
      // ~/.lazy/daemon to avoid colliding with a developer's running daemon.
      // LAZY_DAEMON_BASE_DIR (not HOME) is the documented seam: it moves daemon
      // paths and nothing else — see test/helpers/daemon-base-dir.ts.
      tmpDir = await makeDaemonBaseDir();
      originalBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
      process.env.LAZY_DAEMON_BASE_DIR = tmpDir;
    });

    afterEach(async () => {
      if (squatter) {
        try { squatter.stop(true); } catch { /* ignore */ }
        squatter = undefined;
      }
      if (originalBaseDir === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
      else process.env.LAZY_DAEMON_BASE_DIR = originalBaseDir;
      await ctx.cleanup();
      await removeDaemonBaseDir(tmpDir);
    });

    // INVARIANT: failing to bind the web dashboard port is a HARD startup failure.
    // The daemon cannot service container-based workloads (builder, sandbox runners)
    // without a reachable web port — containers call back via host.docker.internal:<port>.
    // Silently degrading (as the old code did) made container RPCs throw the
    // opaque "Daemon context not initialized" error. See CLAUDE.md invariants:
    // "fail hard on remote failures" and "principle of least surprise".
    test('daemon refuses to start with actionable error when web port is busy', async () => {
      // Squat an ephemeral port that the daemon will then try to bind.
      squatter = Bun.serve({ hostname: SQUAT_HOST, port: 0, fetch: () => new Response('squatter') });
      const squattedPort = squatter.port;

      let thrown: unknown = null;
      try {
        await startDaemonServer({
          projectRoot: ctx.root,
          token: 'webbind-test-token',
          socketPath: join(tmpDir, 'webbind.sock'),
          webPort: squattedPort,
          maxPortAttempts: 1,
          _forceBindWebInTest: true,
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      // Error names the port, the failure reason, and actionable fixes.
      expect(message).toContain('Daemon failed to bind web dashboard');
      expect(message).toContain(String(squattedPort));
      expect(message).toContain('host.docker.internal');
      // The range-exhausted case leads with the exact remediation command
      // (built in sibling task daemon-operator-tooling) and names stray
      // daemons as the likely cause — this is the whole point of the task.
      expect(message).toContain('stray daemon');
      expect(message).toContain('lazy daemon kill-stray');
      expect(message).toContain('lazy daemon list');
      expect(message).toContain('lsof -i');
      expect(message).toContain('lazy daemon stop');
      expect(message).toContain('[server]');
    });

    // INVARIANT: when the ENTIRE auto-increment window is occupied (the real
    // port-exhaustion scenario — stray daemons squatting the range), the daemon
    // fails with an actionable error that names the tried range and the exact
    // remediation command (`lazy daemon kill-stray`). It must NOT hang, and it
    // must NOT silently walk past the window onto a far-off port. This is the
    // regression the task was created to prevent (97 e2e strays shoving the
    // real daemon to a high port, clients landing on an empty-store stray).
    test('daemon fails with actionable error when the whole port window is exhausted', async () => {
      // Occupy a contiguous window of ports, then point the daemon at the
      // bottom of that window with maxPortAttempts spanning exactly it. Every
      // port in the walk is busy, so the bind must fail rather than escape the
      // window. We bind port 0 first to learn a free base, then squat upward.
      const WINDOW = 4;
      const squatters: ReturnType<typeof Bun.serve>[] = [];
      // Find a base port with a free contiguous window above it. Retry a few
      // times to dodge the rare case where another process grabs a port
      // mid-scan (ephemeral churn), so the test isn't flaky.
      let basePort = 0;
      for (let scan = 0; scan < 20 && squatters.length < WINDOW; scan++) {
        // Tear down any partial window from a failed scan before retrying.
        for (const s of squatters) s.stop(true);
        squatters.length = 0;
        const probe = Bun.serve({ hostname: SQUAT_HOST, port: 0, fetch: () => new Response('probe') });
        basePort = probe.port!;
        probe.stop(true);
        try {
          for (let i = 0; i < WINDOW; i++) {
            squatters.push(Bun.serve({ hostname: SQUAT_HOST, port: basePort + i, fetch: () => new Response('squat') }));
          }
        } catch {
          // A port in the window was taken between probe and squat — rescan.
        }
      }
      expect(squatters.length).toBe(WINDOW);

      try {
        let thrown: unknown = null;
        try {
          await startDaemonServer({
            projectRoot: ctx.root,
            token: 'window-exhaust-token',
            socketPath: join(tmpDir, 'window-exhaust.sock'),
            webPort: basePort,
            maxPortAttempts: WINDOW,
            _forceBindWebInTest: true,
          });
        } catch (err) {
          thrown = err;
        }

        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        // Names the exact range that was tried, all busy.
        expect(message).toContain(`${basePort}–${basePort + WINDOW - 1}`);
        expect(message).toContain('all busy');
        // Names stray daemons as the cause and the remediation command.
        expect(message).toContain('stray daemon');
        expect(message).toContain('lazy daemon kill-stray');
        // Did NOT escape the window onto a far-off port.
        expect(isDaemonRunning(ctx.root)).toBe(false);
      } finally {
        for (const s of squatters) s.stop(true);
      }
    });

    // INVARIANT: after a web-bind failure, the daemon leaves no partial state
    // behind — no stale PID file, no stale unix socket, no leaked flock. A
    // subsequent start (once the port is freed) must succeed without manual
    // cleanup, and isDaemonRunning() must report false in the interim.
    test('no stale daemon state remains after failed startup', async () => {
      squatter = Bun.serve({ hostname: SQUAT_HOST, port: 0, fetch: () => new Response('squatter') });
      const squattedPort = squatter.port;
      const sockPath = join(tmpDir, 'webbind-stale.sock');

      await expect(
        startDaemonServer({
          projectRoot: ctx.root,
          token: 'webbind-stale-token',
          socketPath: sockPath,
          webPort: squattedPort,
          maxPortAttempts: 1,
          _forceBindWebInTest: true,
        }),
      ).rejects.toThrow(/Daemon failed to bind web dashboard/);

      // isDaemonRunning is the unified liveness check used by start/stop/status.
      // If the teardown missed any file, the next `lazy daemon start` would
      // refuse with "already running" despite no daemon actually existing.
      expect(isDaemonRunning(ctx.root)).toBe(false);

      // The socket file we passed is cleaned up.
      expect(existsSync(sockPath)).toBe(false);

      // PID file in the default location (under $HOME/.lazy/daemon/<slug>/)
      // is cleaned up.
      const { getPidPath } = await import('../../src/daemon/paths');
      expect(existsSync(getPidPath(ctx.root))).toBe(false);

      // Starting a fresh daemon — this time with noWeb so we don't need to
      // free the squatted port — succeeds cleanly.
      const fresh = await startDaemonServer({
        projectRoot: ctx.root,
        token: 'webbind-fresh-token',
        socketPath: join(tmpDir, 'webbind-fresh.sock'),
        noWeb: true,
      });
      try {
        const resp = await fetch('http://localhost/daemon/status', {
          unix: join(tmpDir, 'webbind-fresh.sock'),
          headers: { 'Authorization': 'Bearer webbind-fresh-token' },
        } as any);
        expect(resp.ok).toBe(true);
      } finally {
        await fresh.stop();
      }
    });

    // INVARIANT: when the daemon fails to bind, the error message appears at
    // the END of daemon.log (i.e., `tail daemon.log` shows it), not only at
    // the beginning where stderr redirection would dump it. This is the
    // regression that caused the reported "silent hang" — the bind-failure
    // error was being written to the file at position 0 (overwriting old
    // content) while logger.* appendFileSync writes landed at the end.
    // Users ran `tail daemon.log` and saw the log appear frozen at
    // "Daemon sync loop enabled", with no indication of the actual failure.
    //
    // The fix has two parts: (1) logger.error is called BEFORE throw so the
    // error is guaranteed to appear via appendFileSync at end-of-file, and
    // (2) auto-start.ts opens the log file with O_APPEND so the child's
    // stderr also appends rather than overwriting at position 0. This test
    // verifies part (1); part (2) is tested via the fd behavior of spawn().
    test('bind failure logs actionable error to end of daemon log', async () => {
      const { logger } = await import('../../src/utils/logger');
      const logPath = join(tmpDir, 'daemon.log');
      // Pre-populate the log with old content to simulate a prior daemon run.
      // If the error were written at position 0 (the old bug), these lines
      // would be overwritten and the test below would fail.
      await writeFile(
        logPath,
        'old line 1 (from previous run)\n' +
        'old line 2 (from previous run)\n' +
        'old line 3 (from previous run)\n',
      );

      // Wire the logger to our test log file. startDaemonServer skips
      // logger.setLogFile when LAZY_TEST=1, so we set it explicitly.
      const originalLogFile = (logger as any).config.logFile;
      logger.setLogFile(logPath);

      try {
        squatter = Bun.serve({ hostname: SQUAT_HOST, port: 0, fetch: () => new Response('squatter') });
        const squattedPort = squatter.port;

        const startTime = Date.now();
        await expect(
          startDaemonServer({
            projectRoot: ctx.root,
            token: 'webbind-tail-token',
            socketPath: join(tmpDir, 'webbind-tail.sock'),
            webPort: squattedPort,
            maxPortAttempts: 1,
            _forceBindWebInTest: true,
          }),
        ).rejects.toThrow(/Daemon failed to bind web dashboard/);

        // Bounded time: bind failure must surface fast, not hang.
        // A silent hang would exceed this budget by far.
        const elapsedMs = Date.now() - startTime;
        expect(elapsedMs).toBeLessThan(5_000);

        const logContent = await readFile(logPath, 'utf-8');

        // The actionable error must be IN the log file (not just thrown).
        expect(logContent).toContain('Daemon failed to bind web dashboard');
        expect(logContent).toContain(String(squattedPort));

        // Pre-existing content must be preserved — logger uses appendFileSync
        // which always writes at end-of-file. If the error were written via a
        // non-append fd at position 0, line 1 would be overwritten.
        expect(logContent).toContain('old line 1 (from previous run)');

        // The error must appear in the LAST section of the log, so that
        // `tail daemon.log` surfaces it. This is the critical user-facing
        // property — users debug by tailing the log.
        const lines = logContent.trim().split('\n').filter(l => l.length > 0);
        const lastTenLines = lines.slice(-10).join('\n');
        expect(lastTenLines).toContain('Daemon failed to bind web dashboard');
      } finally {
        // Reset logger to prior state so this test doesn't bleed into others.
        if (originalLogFile) {
          logger.setLogFile(originalLogFile);
        } else {
          (logger as any).config.logFile = undefined;
        }
      }
    });
  });

  // INVARIANT: the daemon's TCP server (unauthenticated web dashboard + the
  // /mcp and /rpc endpoints) binds to loopback (127.0.0.1) by DEFAULT so it is
  // not reachable from other machines on the network. Remote/LAN access is an
  // explicit opt-in via [server] bind in lazy.toml. See docs/reviews finding S2.
  describe('web binding interface', () => {
    let ctx: TestContext;
    let tmpDir: string;
    let originalHome: string | undefined;
    let originalConfig: string | undefined;
    let daemon: RunningDaemon | undefined;

    beforeEach(async () => {
      process.env.LAZY_TEST = '1';
      ctx = await setupTestLazy();
      tmpDir = await mkdtemp(join(tmpdir(), 'lazy-daemon-bind-'));
      originalHome = process.env.HOME;
      process.env.HOME = tmpDir;
      // Pin LAZY_CONFIG to the isolated project's lazy.toml. Without this,
      // loadConfig walks up from process.cwd() (the lazy repo worktree running
      // the test) and picks up THAT lazy.toml instead of the test project's —
      // so the bind override below would never be read.
      originalConfig = process.env.LAZY_CONFIG;
      process.env.LAZY_CONFIG = join(ctx.root, 'lazy.toml');
    });

    afterEach(async () => {
      if (daemon) {
        try { await daemon.stop(); } catch { /* ignore */ }
        daemon = undefined;
      }
      process.env.HOME = originalHome;
      if (originalConfig === undefined) delete process.env.LAZY_CONFIG;
      else process.env.LAZY_CONFIG = originalConfig;
      await ctx.cleanup();
      await rm(tmpDir, { recursive: true, force: true });
    });

    test('binds the web server to 127.0.0.1 by default', async () => {
      // No [server] bind set in lazy.toml — must default to loopback.
      daemon = await startDaemonServer({
        projectRoot: ctx.root,
        token: 'bind-default-token',
        socketPath: join(tmpDir, 'bind-default.sock'),
        webPort: 0, // ephemeral free port — never collides
        _forceBindWebInTest: true,
      });
      expect(daemon.webServer).toBeDefined();
      expect(daemon.webServer!.hostname).toBe('127.0.0.1');
    });

    // INVARIANT: /daemon/status reports the ACTUAL bind interface (127.0.0.1),
    // not a hardcoded `localhost`. The CLI threads this through to the printed
    // dashboard URL — `localhost` can resolve to IPv6 ::1 and miss an IPv4-only
    // 127.0.0.1 bind, leaving users staring at an empty dashboard.
    test('status payload reports bindHost=127.0.0.1 and a real port (not localhost)', async () => {
      daemon = await startDaemonServer({
        projectRoot: ctx.root,
        token: 'bind-status-token',
        socketPath: join(tmpDir, 'bind-status.sock'),
        webPort: 0,
        _forceBindWebInTest: true,
      });
      const resp = await fetch('http://localhost/daemon/status', {
        unix: join(tmpDir, 'bind-status.sock'),
        headers: { 'Authorization': 'Bearer bind-status-token' },
      } as any);
      expect(resp.ok).toBe(true);
      const data = await resp.json() as any;
      expect(data.bindHost).toBe('127.0.0.1');
      expect(data.webPort).toBeGreaterThan(0);
      // The user-facing URL must point at the real interface + port.
      expect(formatDashboardUrl(data.bindHost, data.webPort)).toBe(`http://127.0.0.1:${data.webPort}`);
      expect(formatDashboardUrl(data.bindHost, data.webPort)).not.toContain('localhost');
    });

    test('opt-in: [server] bind in lazy.toml changes the bind address', async () => {
      // Explicit opt-in to LAN exposure — the daemon must honor it. Insert the
      // key into the existing [server] section rather than clobbering the file
      // (which would drop storage config and risk a duplicate-section TOML error).
      const configPath = join(ctx.root, 'lazy.toml');
      const original = await readFile(configPath, 'utf-8');
      const patched = original.includes('[server]')
        ? original.replace('[server]', '[server]\nbind = "0.0.0.0"')
        : original + '\n[server]\nbind = "0.0.0.0"\n';
      await writeFile(configPath, patched);
      daemon = await startDaemonServer({
        projectRoot: ctx.root,
        token: 'bind-optin-token',
        socketPath: join(tmpDir, 'bind-optin.sock'),
        webPort: 0,
        _forceBindWebInTest: true,
      });
      expect(daemon.webServer).toBeDefined();
      expect(daemon.webServer!.hostname).toBe('0.0.0.0');
      expect(daemon.bindHost).toBe('0.0.0.0');
      // Display rule: a 0.0.0.0 (all-interfaces) bind is reachable locally via
      // loopback, so the convenient URL we show the user is 127.0.0.1 — never
      // a literal `0.0.0.0`, which is not a connectable address in a browser.
      expect(formatDashboardUrl(daemon.bindHost, daemon.webServer!.port!)).toBe(
        `http://127.0.0.1:${daemon.webServer!.port}`,
      );
    });
  });

  // Pure unit coverage for the host→display-URL formatting rule. Centralizing
  // this in one helper (formatDashboardUrl) is what keeps the ~5 print sites
  // from drifting back to a hardcoded `localhost`.
  describe('formatDashboardUrl', () => {
    test('loopback bind prints 127.0.0.1', () => {
      expect(formatDashboardUrl('127.0.0.1', 26024)).toBe('http://127.0.0.1:26024');
    });
    test('all-interfaces binds (0.0.0.0 / ::) collapse to loopback for local convenience', () => {
      expect(formatDashboardUrl('0.0.0.0', 26024)).toBe('http://127.0.0.1:26024');
      expect(formatDashboardUrl('::', 26024)).toBe('http://127.0.0.1:26024');
    });
    test('a specific interface IP is shown as-is', () => {
      expect(formatDashboardUrl('192.168.1.50', 8080)).toBe('http://192.168.1.50:8080');
    });
    test('missing bindHost (older daemon payload) falls back to loopback', () => {
      expect(formatDashboardUrl(undefined, 26024)).toBe('http://127.0.0.1:26024');
    });
  });

  describe('daemon status shows web state', () => {
    let ctx: TestContext;

    beforeEach(async () => {
      ctx = await setupTestLazy();
    });

    afterEach(async () => {
      await ctx.cleanup();
    });

    // INVARIANT: `lazy daemon status` must always print the Web: line when
    // the daemon is running. Silently omitting it (as the pre-fix code did)
    // hid the degraded state — users saw "daemon running" while container
    // RPCs blew up with "Daemon context not initialized". This is a defensive
    // test — post-fix the daemon refuses to start without a web port, so the
    // degraded branch should never be hit in practice, but the output must
    // never silently regress.
    test('daemonStatus output includes Web line when webPort is missing', async () => {
      // Test the CLI's formatting decision directly. We spin up a real
      // daemon with noWeb:true (which leaves status.webPort undefined) and
      // invoke the status command against it through the default socket
      // path. This requires routing LAZY_DAEMON_BASE_DIR so the default
      // socket path lands in our temp dir (see test/helpers/daemon-base-dir.ts).
      const tmpDir = await makeDaemonBaseDir();
      const originalBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
      process.env.LAZY_DAEMON_BASE_DIR = tmpDir;
      const unpinConfig = pinConfig(ctx.root);
      process.env.LAZY_TEST = '1';

      try {
        const { getSocketPath } = await import('../../src/daemon/paths');
        const defaultSocket = getSocketPath(ctx.root);
        // Do NOT pass `token` — startDaemonServer only persists the token
        // file when it generates one itself. isDaemonRunning() in the CLI
        // subprocess needs the token file to exist to pass its readToken()
        // check.
        const daemon = await startDaemonServer({
          projectRoot: ctx.root,
          socketPath: defaultSocket,
          noWeb: true,
        });
        try {
          // Pass --project explicitly so the subprocess doesn't walk up to
          // the outer worktree's lazy.toml and look at the wrong daemon dir.
          const result = await ctx.lazy(['daemon', 'status', '--project', ctx.root], {
            env: { LAZY_DAEMON_BASE_DIR: tmpDir, LAZY_CONFIG: join(ctx.root, 'lazy.toml'), LAZY_TEST: '1' },
          });
          expectSuccess(result);
          expectOutput(result, 'Daemon is running');
          // Critical: the Web: line is always printed, even in degraded mode.
          expectOutput(result, 'Web:');
          expectOutput(result, 'not bound');
        } finally {
          await daemon.stop();
        }
      } finally {
        unpinConfig();
        if (originalBaseDir === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
        else process.env.LAZY_DAEMON_BASE_DIR = originalBaseDir;
        await removeDaemonBaseDir(tmpDir);
      }
    });
  });

  describe('daemon status shows proxy state', () => {
    let ctx: TestContext;

    beforeEach(async () => {
      ctx = await setupTestLazy();
    });

    afterEach(async () => {
      await ctx.cleanup();
    });

    // INVARIANT: `lazy daemon status` must surface the proxy — its address (with
    // the OS-assigned port), upstream, fallback count, and policy state. With the
    // port auto-assigned by default, this is the primary way to find the proxy,
    // so the line must always appear when a [proxy] section is configured.
    test('daemonStatus output includes the Proxy line with an OS-assigned port', async () => {
      // Route the DEFAULT daemon paths into a private dir. LAZY_DAEMON_BASE_DIR
      // (not HOME) is the targeted seam — see test/helpers/daemon-base-dir.ts.
      const tmpDir = await makeDaemonBaseDir();
      const originalBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
      process.env.LAZY_DAEMON_BASE_DIR = tmpDir;
      const unpinConfig = pinConfig(ctx.root);
      process.env.LAZY_TEST = '1';
      // The daemon starting the proxy touches storage via getOrCreateStorage,
      // which (like loadConfig) resolves from cwd. A real daemon chdir()s to the
      // project root at startup, but that's skipped under LAZY_TEST (shared
      // process), so mimic it here to isolate storage to ctx.root.
      process.chdir(ctx.root);

      try {
        // A [proxy] section with NO port → OS-assigned. Starting the proxy only
        // binds a local port; it never contacts the upstream, so this is offline-safe.
        const configPath = join(ctx.root, 'lazy.toml');
        const existing = await readFile(configPath, 'utf-8');
        await writeFile(configPath, `${existing}\n[proxy]\nupstream = "https://api.anthropic.com"\n`);

        const { getSocketPath } = await import('../../src/daemon/paths');
        const defaultSocket = getSocketPath(ctx.root);
        const daemon = await startDaemonServer({
          projectRoot: ctx.root,
          socketPath: defaultSocket,
        });
        try {
          const result = await ctx.lazy(['daemon', 'status', '--project', ctx.root], {
            env: { LAZY_DAEMON_BASE_DIR: tmpDir, LAZY_CONFIG: join(ctx.root, 'lazy.toml'), LAZY_TEST: '1' },
          });
          expectSuccess(result);
          expectOutput(result, 'Daemon is running');
          expectOutput(result, 'Proxy:');
          expectOutput(result, 'https://api.anthropic.com');
          expectOutput(result, 'policy on');
          // The advertised port must be the real bound one, never the config 0.
          expectOutput(result, `http://127.0.0.1:${daemon.proxyServer?.port}`);
        } finally {
          await daemon.stop();
        }
      } finally {
        process.chdir(STABLE_CWD);
        unpinConfig();
        if (originalBaseDir === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
        else process.env.LAZY_DAEMON_BASE_DIR = originalBaseDir;
        await removeDaemonBaseDir(tmpDir);
      }
    });

    // INVARIANT (default-on proxy): a project with NO [proxy] section still gets
    // the proxy. This is the headline v0.20 behavior change — if this regresses,
    // agent traffic silently stops being audited.
    test('daemon with NO [proxy] config still starts the proxy and reports it', async () => {
      // Route the DEFAULT daemon paths into a private dir. LAZY_DAEMON_BASE_DIR
      // (not HOME) is the targeted seam — see test/helpers/daemon-base-dir.ts.
      const tmpDir = await makeDaemonBaseDir();
      const originalBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
      process.env.LAZY_DAEMON_BASE_DIR = tmpDir;
      const unpinConfig = pinConfig(ctx.root);
      process.env.LAZY_TEST = '1';
      process.chdir(ctx.root);

      try {
        // Deliberately do NOT write a [proxy] section.
        const { getSocketPath } = await import('../../src/daemon/paths');
        const daemon = await startDaemonServer({
          projectRoot: ctx.root,
          socketPath: getSocketPath(ctx.root),
        });
        try {
          // The proxy is listening on an OS-assigned port with no config at all.
          expect(daemon.proxyServer).toBeDefined();
          expect(daemon.proxyServer?.port).toBeGreaterThan(0);

          const result = await ctx.lazy(['daemon', 'status', '--project', ctx.root], {
            env: { LAZY_DAEMON_BASE_DIR: tmpDir, LAZY_CONFIG: join(ctx.root, 'lazy.toml'), LAZY_TEST: '1' },
          });
          expectSuccess(result);
          expectOutput(result, 'Proxy:');
          expectOutput(result, 'https://api.anthropic.com'); // defaulted upstream
          expectOutput(result, 'policy on');                 // defaulted closed posture
        } finally {
          await daemon.stop();
        }
      } finally {
        process.chdir(STABLE_CWD);
        unpinConfig();
        if (originalBaseDir === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
        else process.env.LAZY_DAEMON_BASE_DIR = originalBaseDir;
        await removeDaemonBaseDir(tmpDir);
      }
    });

    // INVARIANT: `[proxy] enabled` was REMOVED — the proxy is always on. The
    // value decides what carrying the key still does, and this test covers the
    // refusing half: `enabled = false` asks for something lazy no longer does,
    // so the daemon REFUSES TO START, naming the option, rather than coming up
    // while the user believes their traffic is unproxied. (`enabled = true`
    // asks for what lazy already does, so it only warns and runs on — covered
    // in test/e2e/proxy-fail-loud.test.ts.) This replaces the old
    // "enabled = false starts no proxy" test: that state no longer exists.
    test('a config carrying [proxy] enabled = false fails daemon startup', async () => {
      // Route the DEFAULT daemon paths into a private dir. LAZY_DAEMON_BASE_DIR
      // (not HOME) is the targeted seam — see test/helpers/daemon-base-dir.ts.
      const tmpDir = await makeDaemonBaseDir();
      const originalBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
      process.env.LAZY_DAEMON_BASE_DIR = tmpDir;
      const unpinConfig = pinConfig(ctx.root);
      process.env.LAZY_TEST = '1';
      process.chdir(ctx.root);

      try {
        const configPath = join(ctx.root, 'lazy.toml');
        const existing = await readFile(configPath, 'utf-8');
        await writeFile(configPath, `${existing}\n[proxy]\nenabled = false\n`);

        const { getSocketPath } = await import('../../src/daemon/paths');
        await expect(startDaemonServer({
          projectRoot: ctx.root,
          socketPath: getSocketPath(ctx.root),
        })).rejects.toThrow(/`enabled` option has been removed/);
      } finally {
        process.chdir(STABLE_CWD);
        unpinConfig();
        if (originalBaseDir === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
        else process.env.LAZY_DAEMON_BASE_DIR = originalBaseDir;
        await removeDaemonBaseDir(tmpDir);
      }
    });
  });

  // Tests for the background-daemon startup UX: when the detached child
  // fails to come up, (a) the actionable error must appear in daemon.log
  // exactly once, and (b) `lazy daemon start` (background) must surface the
  // actionable error to the caller's terminal, not the opaque "Daemon did
  // not start within 5s".
  //
  // These exercise the full spawn pipeline end-to-end by invoking the real
  // CLI via subprocess:
  //   ctx.lazy → lazy daemon start → startDaemonBackground
  //     → spawn(lazy daemon start --foreground)
  //     → child's startDaemonServer → bind failure → marker + throw
  //     → parent's readiness race loses → reads marker → throws actionable error
  //     → top-level catch → stderr
  //
  // They MUST NOT call startDaemonBackground in-process from the test file:
  // getLazyCommand() returns [bun, process.argv[1]], and in a test context
  // argv[1] is the *.test.ts file, not src/index.ts. Spawning that makes
  // the "daemon" grandchild evaluate the test file, which errors out with
  // "Cannot use test outside of the test runner" and the code paths we are
  // trying to verify never run.
  describe('background startup error UX', () => {
    let ctx: TestContext;
    let tmpHome: string;
    // Daemon state goes here rather than under tmpHome. tmpHome exists to hide
    // the developer's real ~/.claude from the credential gate; it should NOT
    // also be deciding where the socket, PID and log live — that is
    // LAZY_DAEMON_BASE_DIR's job. See test/helpers/daemon-base-dir.ts.
    let daemonBaseDir: string;
    let squatter: ReturnType<typeof Bun.serve> | undefined;

    beforeEach(async () => {
      ctx = await setupTestLazy();
      tmpHome = await mkdtemp(join(tmpdir(), 'lazy-daemon-startup-ux-'));
      daemonBaseDir = await makeDaemonBaseDir();
    });

    afterEach(async () => {
      if (squatter) {
        try { squatter.stop(true); } catch { /* ignore */ }
        squatter = undefined;
      }
      await ctx.cleanup();
      await rm(tmpHome, { recursive: true, force: true });
      await removeDaemonBaseDir(daemonBaseDir);
    });

    /**
     * Force a bind failure by squatting port 65535 and pinning the daemon's
     * configured port to 65535. Bun clamps port > 65535 down to 65535, so all
     * 100 auto-retry attempts collide with the squatter and the daemon's
     * bind path takes the "no free port in range" failure branch.
     *
     * The generated lazy.toml already contains a `[server]` section with
     * `port = 26024` — appending another `[server]` would be a duplicate key
     * and the TOML parser would silently reject it, leaving the default
     * port in force. We rewrite the existing `port = ...` line in place
     * instead.
     */
    async function forceBindFailure(projectRoot: string): Promise<void> {
      squatter = Bun.serve({ hostname: SQUAT_HOST, port: 65535, fetch: () => new Response('squatter') });
      const configPath = join(projectRoot, 'lazy.toml');
      const existing = await readFile(configPath, 'utf-8');
      const updated = existing.replace(/^port\s*=\s*\d+/m, 'port = 65535');
      if (updated === existing) {
        throw new Error('forceBindFailure: failed to rewrite port in lazy.toml');
      }
      await writeFile(configPath, updated);
    }

    // INVARIANT: daemon bind failure is logged exactly once in daemon.log —
    // no duplicate writes from the top-level error handler.
    //
    // Before this fix, the same bind-failure message landed in daemon.log
    // three times: once from logger.error's file write (with timestamp),
    // once from logger.error's console.error (stderr → daemon.log via
    // O_APPEND), and once from src/index.ts's top-level catch console.error.
    // Users debugging a failed `lazy upgrade` saw the same error block
    // repeated three times, which made the real (single) cause look
    // ambiguous. Now: one write, one timestamp, one entry.
    test('daemon bind failure writes to daemon.log exactly once', async () => {
      await forceBindFailure(ctx.root);

      // Invoke the real CLI in background mode; it will spawn the daemon
      // grandchild, fail to bind, and exit non-zero. HOME is pinned to a
      // tmp dir so the real developer daemon directory is untouched.
      // LAZY_TEST='' overrides any contamination from earlier tests in the
      // suite — with LAZY_TEST=1 inherited, ensureDaemon() short-circuits
      // and the bind path we need to exercise never runs.
      const result = await ctx.lazy(['daemon', 'start'], {
        env: { HOME: tmpHome, LAZY_DAEMON_BASE_DIR: daemonBaseDir, LAZY_TEST: '' },
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Daemon failed to bind web dashboard');

      // Locate the daemon log under the isolated base dir — getDaemonDir hashes
      // the project root, so we reuse the same helpers the code uses.
      const { getLogPath } = await import('../../src/daemon/paths');
      const origBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
      process.env.LAZY_DAEMON_BASE_DIR = daemonBaseDir;
      let logContent: string;
      try {
        logContent = await readFile(getLogPath(ctx.root), 'utf-8');
      } finally {
        if (origBaseDir === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
        else process.env.LAZY_DAEMON_BASE_DIR = origBaseDir;
      }

      // Count occurrences of the signature phrase. The phrase only appears
      // as part of the actionable error — every occurrence is one write.
      // The pre-fix behavior produced 3; the post-fix must produce exactly 1.
      const occurrences = (logContent.match(/Daemon failed to bind web dashboard/g) ?? []).length;
      expect(occurrences).toBe(1);

      // The surviving entry must be the timestamped logger.* line, not a
      // raw stderr write. Logger entries are prefixed with an ISO timestamp
      // and the `[ERROR]` tag — a raw console.error write has neither.
      expect(logContent).toMatch(/\[ERROR\]\s*:\s*Daemon failed to bind web dashboard/);
    }, 20_000);

    // INVARIANT: startDaemonBackground throws the daemon's actionable error
    // (not a generic timeout) when the child dies before becoming ready.
    //
    // Before this fix, users of `lazy upgrade` / `lazy daemon start` saw
    // only "Daemon did not start within 5 seconds. Check logs: <path>".
    // The actionable error (port conflict + fix instructions) lived in the
    // log file but required the user to open it. Now: the CLI's stderr
    // carries the same text the log file carries — no log-diving required.
    test('surfaces the actionable bind error instead of a generic timeout', async () => {
      await forceBindFailure(ctx.root);

      // LAZY_TEST='' overrides any contamination from earlier tests in the
      // suite — with LAZY_TEST=1 inherited, ensureDaemon() short-circuits
      // and the bind path we need to exercise never runs.
      const result = await ctx.lazy(['daemon', 'start'], {
        env: { HOME: tmpHome, LAZY_DAEMON_BASE_DIR: daemonBaseDir, LAZY_TEST: '' },
      });

      expect(result.exitCode).not.toBe(0);

      // The actionable text must be present: the port, the root cause, and
      // at least one remediation pointer. These are what the user needs on
      // their terminal — without them we've just relocated the log-diving.
      expect(result.stderr).toContain('Daemon failed to bind web dashboard');
      expect(result.stderr).toContain('65535');
      expect(result.stderr).toContain('lsof -i');

      // The old generic message must NOT appear — seeing it would mean we
      // swallowed the marker and fell through to the timeout path.
      expect(result.stderr).not.toContain('Daemon did not start within');
    }, 20_000);
  });

  // The daemon is the SINGLE enforcement point for auth: it launches task
  // containers that inherit its credential, so gating the daemon itself on
  // credential presence eliminates the "daemon up but every container
  // unauthenticated" failure mode at the source. These tests exercise the gate
  // end-to-end through the real CLI (subprocess), with HOME pinned to a tmp dir
  // so the developer's real daemon directory is untouched and LAZY_TEST=''
  // so the daemon start path actually runs.
  describe('credential gate', () => {
    let ctx: TestContext;
    let tmpHome: string;
    // HOME stays a temp dir (it is what hides the developer's real ~/.claude
    // credential from the gate), but daemon state belongs under the targeted
    // LAZY_DAEMON_BASE_DIR seam, not wherever HOME happens to point.
    // See test/helpers/daemon-base-dir.ts.
    let daemonBaseDir: string;

    beforeEach(async () => {
      ctx = await setupTestLazy();
      tmpHome = await mkdtemp(join(tmpdir(), 'lazy-daemon-credgate-'));
      daemonBaseDir = await makeDaemonBaseDir();
    });

    afterEach(async () => {
      await ctx.cleanup();
      await rm(tmpHome, { recursive: true, force: true });
      await removeDaemonBaseDir(daemonBaseDir);
    });

    // INVARIANT: the daemon refuses to start when no Claude Code OAuth token /
    // Anthropic API key is present, with an actionable error naming both env
    // vars. This is what makes dropping the client-side checks safe.
    test('daemon refuses to start without a credential', async () => {
      const result = await ctx.lazy(['daemon', 'start'], {
        env: {
          HOME: tmpHome,
          LAZY_DAEMON_BASE_DIR: daemonBaseDir,
          LAZY_TEST: '',
          ANTHROPIC_API_KEY: '',
          CLAUDE_CODE_OAUTH_TOKEN: '',
        },
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Daemon refuses to start');
      // Actionable: names both credential env vars and how to set them.
      expect(result.stderr).toContain('CLAUDE_CODE_OAUTH_TOKEN');
      expect(result.stderr).toContain('ANTHROPIC_API_KEY');
    });

    // INVARIANT: `daemon restart` pre-flights the gate BEFORE it stops anything.
    // A restart run from a credential-less shell must leave the existing daemon
    // ALIVE — the destructive half must not happen when the rebuild half is
    // going to be refused, or the project is left with no daemon at all.
    test('daemon restart refuses without a credential and leaves the running daemon alive', async () => {
      // Unlike the test above, this one needs the first `daemon start` to
      // SUCCEED — which means really binding a TCP web port. Left on the
      // default, the daemon walks the 26024+ window, which is shared by every
      // lazy project on the machine: on a developer box with a pile of running
      // (or stray) daemons the walk can come up empty and the start fails for
      // reasons that have nothing to do with the credential gate this test is
      // about. Pin a port the OS just told us is free instead.
      await pinFreeServerPort(ctx.root);

      const withCredential = {
        HOME: tmpHome,
        LAZY_DAEMON_BASE_DIR: daemonBaseDir,
        LAZY_TEST: '',
        ANTHROPIC_API_KEY: 'sk-ant-fake-for-test',
        CLAUDE_CODE_OAUTH_TOKEN: '',
      };

      const started = await ctx.lazy(['daemon', 'start'], { env: withCredential });
      expect(started.exitCode).toBe(0);

      try {
        const restart = await ctx.lazy(['daemon', 'restart'], {
          env: { ...withCredential, ANTHROPIC_API_KEY: '' },
        });
        expect(restart.exitCode).not.toBe(0);
        expect(restart.stderr).toContain('Daemon refuses to start');

        // The pre-existing daemon survived the refused restart.
        const status = await ctx.lazy(['daemon', 'status'], { env: withCredential });
        expect(status.exitCode).toBe(0);
        expect(status.stdout).toContain('running');
      } finally {
        await ctx.lazy(['daemon', 'stop'], { env: withCredential });
      }
    });
  });

  // INVARIANT: `lazy daemon status` surfaces the build time of the running
  // daemon binary. In dev/test there is no compile step, so it reports 'dev'
  // (graceful fallback) instead of crashing or printing a misleading value.
  describe('daemon status shows build time', () => {
    let ctx: TestContext;

    beforeEach(async () => {
      ctx = await setupTestLazy();
    });

    afterEach(async () => {
      await ctx.cleanup();
    });

    test('status output includes the Built line', async () => {
      // Route the DEFAULT daemon paths into a private dir. LAZY_DAEMON_BASE_DIR
      // (not HOME) is the targeted seam — see test/helpers/daemon-base-dir.ts.
      const tmpDir = await makeDaemonBaseDir();
      const originalBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
      process.env.LAZY_DAEMON_BASE_DIR = tmpDir;
      const unpinConfig = pinConfig(ctx.root);
      process.env.LAZY_TEST = '1';

      try {
        const { getSocketPath } = await import('../../src/daemon/paths');
        const defaultSocket = getSocketPath(ctx.root);
        const daemon = await startDaemonServer({
          projectRoot: ctx.root,
          socketPath: defaultSocket,
          noWeb: true,
        });
        try {
          const result = await ctx.lazy(['daemon', 'status', '--project', ctx.root], {
            env: { LAZY_DAEMON_BASE_DIR: tmpDir, LAZY_CONFIG: join(ctx.root, 'lazy.toml'), LAZY_TEST: '1' },
          });
          expectSuccess(result);
          expectOutput(result, 'Daemon is running');
          expectOutput(result, 'Built:');
          // The real invariant is that status ALWAYS resolves a build stamp and
          // never crashes on a missing one — either the compile-time timestamp
          // or the graceful 'dev' fallback (src/daemon/server.ts).
          //
          // This used to assert 'dev' unconditionally, on the premise "no build
          // step in tests". That premise is false for the project's own test
          // entry points: `bun run test` / `test:e2e` / `test:all` all run
          // `generate:version` first (package.json), which writes a REAL ISO
          // timestamp into the gitignored src/build-info.ts. So the assertion
          // passed only under bare `bun test` in a worktree that had never been
          // built, and failed for everyone else — invisibly, since this suite is
          // behind LAZY_SLOW_TESTS=1.
          const builtLine = result.stdout.split('\n').find(l => l.includes('Built:'));
          expect(builtLine).toBeDefined();
          expect(
            /Built:\s+(dev|\d{4}-\d{2}-\d{2}T[\d:.]+Z \(UTC\))\s*$/.test(builtLine!),
          ).toBe(true);
        } finally {
          await daemon.stop();
        }
      } finally {
        unpinConfig();
        if (originalBaseDir === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
        else process.env.LAZY_DAEMON_BASE_DIR = originalBaseDir;
        await removeDaemonBaseDir(tmpDir);
      }
    });
  });
});
