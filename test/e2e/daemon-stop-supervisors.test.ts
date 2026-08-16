/**
 * E2E tests for daemon stop supervisor termination.
 *
 * Verifies that `daemon.stop()` kills active supervisor processes/containers
 * before shutting down, preventing orphaned supervisors.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTaskBeforeDaemon } from '../helpers/fixtures';
import { isolateInProcessDaemonEnv } from '../helpers/in-process-daemon';

/** Check if a process with the given PID is alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Configure a test project to use the host-process runner. */
function configureHostProcessRunner(projectRoot: string): void {
  const configPath = join(projectRoot, 'lazy.toml');
  const config = readFileSync(configPath, 'utf-8');
  writeFileSync(
    configPath,
    config.replace(/\[runner\][^\[]*/, '[runner]\ntype = "dangerously-host-process-without-any-isolation"\n'),
  );
}

/** Spawn a dummy long-running process and return its PID. */
function spawnDummyProcess(): { pid: number; kill: () => void } {
  const proc = Bun.spawn(['sleep', '3600'], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return {
    pid: proc.pid,
    kill: () => { try { process.kill(proc.pid, 'SIGKILL'); } catch { /* already dead */ } },
  };
}

/** Write a PID file so the host-process runner discovers this as a running supervisor. */
function writePidFile(homeDir: string, runName: string, pid: number): void {
  const pidDir = join(homeDir, '.lazy', 'run');
  mkdirSync(pidDir, { recursive: true });
  writeFileSync(
    join(pidDir, `${runName}.json`),
    JSON.stringify({ pid, startedAt: new Date().toISOString(), logFile: '/dev/null' }),
  );
}

// This suite runs a daemon IN-PROCESS; keep the LAZY_IS_DAEMON flag that
// startDaemonServer() sets process-wide from leaking into later test files.
isolateInProcessDaemonEnv();

describe('daemon stop supervisor termination', () => {
  let daemon: RunningDaemon;
  let ctx: TestContext;
  let tmpDir: string;
  let socketPath: string;
  let token: string;
  let originalHome: string | undefined;
  let originalLazyConfig: string | undefined;
  let dummyProcesses: { kill: () => void }[];

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    ctx = await setupTestLazy();
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-daemon-stop-sup-'));
    socketPath = join(tmpDir, 'test.sock');
    token = 'stop-sup-test-token';
    originalHome = process.env.HOME;
    originalLazyConfig = process.env.LAZY_CONFIG;
    dummyProcesses = [];
    // Redirect HOME so PID files go to an isolated location
    process.env.HOME = tmpDir;
    // Point config at test project so loadConfig doesn't walk to repo root
    process.env.LAZY_CONFIG = join(ctx.root, 'lazy.toml');
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (originalLazyConfig !== undefined) {
      process.env.LAZY_CONFIG = originalLazyConfig;
    } else {
      delete process.env.LAZY_CONFIG;
    }
    // Clean up any dummy processes that survived
    for (const p of dummyProcesses) { p.kill(); }
    if (daemon) {
      try { await daemon.stop(); } catch { /* may already be stopped */ }
    }
    await ctx.cleanup();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // INVARIANT: Daemon stop terminates all active supervisor processes that
  // belong to tracked projects. Without this, supervisors become orphans.
  test('stop kills active host-process supervisors for known tasks', async () => {
    configureHostProcessRunner(ctx.root);

    // Create a task so we have a known task ID in the project
    const taskShortId = await createTaskBeforeDaemon(ctx, 'Supervisor stop test task');

    // Start a dummy process that simulates a supervisor
    const dummy = spawnDummyProcess();
    dummyProcesses.push(dummy);
    expect(isAlive(dummy.pid)).toBe(true);

    // Write a PID file using the real task's short ID
    writePidFile(tmpDir, `lazy-${taskShortId}`, dummy.pid);

    // Start daemon and pre-populate knownTaskIds with this task
    daemon = await startDaemonServer({
      socketPath,
      token,
      projectRoot: ctx.root,
      reconcileIntervalSeconds: 999,
    });
    daemon.knownTaskIds.add(taskShortId);

    // Stop the daemon — should kill the supervisor process
    await daemon.stop();

    // Give the process a moment to die (stopRun sends SIGTERM then waits)
    await new Promise(resolve => setTimeout(resolve, 500));

    expect(isAlive(dummy.pid)).toBe(false);
  }, 15_000); // stopRun blocks synchronously while waiting for SIGTERM

  // INVARIANT: Daemon stop does NOT kill supervisors that belong to other
  // projects. discoverRunningRuns() is global, so stop() must filter by
  // project-owned task IDs to avoid cross-project interference.
  test('stop does not kill supervisors from other projects', async () => {
    configureHostProcessRunner(ctx.root);

    // Create a task in this project
    const ownedTaskId = await createTaskBeforeDaemon(ctx, 'Owned task');

    // Spawn two dummy processes: one "owned" by this project, one not
    const ownedDummy = spawnDummyProcess();
    const foreignDummy = spawnDummyProcess();
    dummyProcesses.push(ownedDummy, foreignDummy);
    expect(isAlive(ownedDummy.pid)).toBe(true);
    expect(isAlive(foreignDummy.pid)).toBe(true);

    // Write PID files for both
    writePidFile(tmpDir, `lazy-${ownedTaskId}`, ownedDummy.pid);
    writePidFile(tmpDir, 'lazy-cafebabe', foreignDummy.pid); // unknown task ID

    // Start daemon and populate knownTaskIds with only this project's task
    daemon = await startDaemonServer({
      socketPath,
      token,
      projectRoot: ctx.root,
      reconcileIntervalSeconds: 999,
    });
    daemon.knownTaskIds.add(ownedTaskId);

    // Stop the daemon
    await daemon.stop();

    await new Promise(resolve => setTimeout(resolve, 500));

    // Owned supervisor should be killed
    expect(isAlive(ownedDummy.pid)).toBe(false);
    // Foreign supervisor should still be alive — not our project's task
    expect(isAlive(foreignDummy.pid)).toBe(true);
  }, 15_000);

  // INVARIANT: When knownTaskIds is not populated (no reconcile tick has run),
  // stop() must not kill any supervisors — we can't verify ownership, and a
  // just-started daemon has no orphans from this project to clean up.
  test('stop skips all supervisors when knownTaskIds is empty', async () => {
    configureHostProcessRunner(ctx.root);

    // Spawn a dummy process and create a PID file
    const dummy = spawnDummyProcess();
    dummyProcesses.push(dummy);
    writePidFile(tmpDir, 'lazy-abcd1234', dummy.pid);

    // Start daemon WITHOUT populating knownTaskIds (simulates no reconcile tick)
    daemon = await startDaemonServer({
      socketPath,
      token,
      projectRoot: ctx.root,
      reconcileIntervalSeconds: 999,
    });
    // knownTaskIds is not populated — no reconcile has run

    await daemon.stop();

    await new Promise(resolve => setTimeout(resolve, 500));

    // Process should still be alive — stop() skipped it because ownership is unknown
    expect(isAlive(dummy.pid)).toBe(true);
  });

  // INVARIANT: Daemon stop completes even if supervisor termination fails.
  // Shutdown must be best-effort — a stuck supervisor should not block daemon exit.
  test('stop completes even if supervisor termination fails', async () => {
    configureHostProcessRunner(ctx.root);

    // Write a PID file pointing to a non-existent process (PID that's guaranteed dead)
    writePidFile(tmpDir, 'lazy-deadpid1', 999999999);

    // Start daemon
    daemon = await startDaemonServer({
      socketPath,
      token,
      projectRoot: ctx.root,
      reconcileIntervalSeconds: 999,
    });

    // Stop should complete without throwing, even though the PID doesn't exist
    await expect(daemon.stop()).resolves.toBeUndefined();
  });

  // INVARIANT: Daemon stop works when there are no active supervisors.
  // This is the common case — stop should not fail when nothing needs killing.
  test('stop completes when no supervisors are running', async () => {
    configureHostProcessRunner(ctx.root);

    // Start daemon with no supervisors running
    daemon = await startDaemonServer({
      socketPath,
      token,
      projectRoot: ctx.root,
      reconcileIntervalSeconds: 999,
    });

    // Stop should complete without issues
    await expect(daemon.stop()).resolves.toBeUndefined();
  });
});
