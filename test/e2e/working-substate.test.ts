/**
 * E2E tests for working-substate observability.
 *
 * A task in `working` is otherwise opaque: a long post_turn_check, a hung
 * supervisor, and a dead supervisor all render identically. These tests assert
 * that `ls`/`status` surface the derived substate:
 *   - working(agent)            phase=work, run alive
 *   - working(harness:<phase>)  a post-turn phase, run alive
 *   - working(not-alive)        no live run and no response (stranded candidate)
 *
 * The substate is driven by a written status.json (the supervisor's checkpoint)
 * plus run liveness. To make liveness deterministic without Docker, these tests
 * force the host-process runner (pid-file based) and write a pid file pointing at
 * a live pid for the "alive" cases.
 *
 * Setup is done via in-test Storage (no `lazy create`, so no daemon runs during
 * setup and there's no reconcile/lock contention). The read commands then run as
 * subprocesses: `lazy list` auto-starts a daemon, but the hand-made working task
 * is protected from its reconciler by a fresh last_interaction_at (30s grace).
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { mkdir, writeFile, readFile, rm } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createStorage } from '../../src/storage';
import type { Storage } from '../../src/storage';
import { protocolDir as getProtocolDir } from '../../src/protocol';
import type { SupervisorStatus } from '../../src/protocol';
import { getHome } from '../../src/utils/home';

const RUN_NAME = 'lazy-substate-e2e-run';

/** Path the host-process runner reads liveness pid files from. */
function pidFilePath(): string {
  return join(getHome(), '.lazy', 'run', `${RUN_NAME}.json`);
}

/** Force the host-process runner so liveness is pid-file based (no Docker needed). */
async function useHostProcessRunner(root: string): Promise<void> {
  const configPath = join(root, 'lazy.toml');
  const HOST = 'dangerously-host-process-without-any-isolation';
  let existing = '';
  try { existing = await readFile(configPath, 'utf-8'); } catch { /* fresh file */ }
  if (/type\s*=\s*"docker"/.test(existing)) {
    existing = existing.replace(/type\s*=\s*"docker"/, `type = "${HOST}"`);
    await writeFile(configPath, existing);
  } else {
    await writeFile(configPath, `${existing}\n[runner]\ntype = "${HOST}"\n`);
  }
}

/**
 * Create a `working` task with a session whose container_name is RUN_NAME (so the
 * liveness probe keys on the pid file we control). Done entirely through Storage —
 * no daemon involved.
 */
async function makeWorkingTask(ctx: TestContext, goal: string): Promise<string> {
  const storage: Storage = await createStorage(ctx.root);
  try {
    const task = await storage.createTask(goal);
    const headSha = ctx.git('rev-parse', 'HEAD').stdout.trim();
    const session = await storage.createSession(task.id, 'claude-code', `lazy/${task.id.slice(0, 8)}`, headSha);
    await storage.updateSessionContainerName(session.id, RUN_NAME);
    // Fresh last_interaction_at → the auto-started daemon's 30s reconcile grace
    // protects this hand-made working task for the duration of the test.
    await storage.updateSessionInteraction(session.id, 0);
    await storage.updateTaskStatus(task.id, 'working', 'system');
    return task.id;
  } finally {
    await storage.close();
  }
}

/** Write the supervisor status.json checkpoint for a task. */
async function writeStatusJson(taskId: string, status: SupervisorStatus): Promise<void> {
  const dir = getProtocolDir(taskId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'status.json'), JSON.stringify(status, null, 2));
}

/** Write a host-process pid file for RUN_NAME pointing at a live pid (this process). */
async function writeAlivePidFile(): Promise<void> {
  const p = pidFilePath();
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), logFile: '/dev/null' }));
}

function baseStatus(taskId: string, overrides: Partial<SupervisorStatus> = {}): SupervisorStatus {
  const now = new Date().toISOString();
  return {
    phase: 'work',
    task_id: taskId,
    command_type: 'start',
    started_at: now,
    updated_at: now,
    phase_started_at: now,
    pid: process.pid,
    ...overrides,
  };
}

describe('working-substate observability', () => {
  let ctx: TestContext;
  let originalCwd: string;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    await useHostProcessRunner(ctx.root);
    // The test process's cwd is this repo, whose lazy.toml can bleed into
    // config/storage resolution for in-test createStorage. Run from the test
    // root so in-test storage resolves to the same place the subprocess reads.
    originalCwd = process.cwd();
    process.chdir(ctx.root);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(pidFilePath(), { force: true });
    await ctx.cleanup();
  });

  test('ls shows working(agent) when phase is work and the run is alive', async () => {
    const taskId = await makeWorkingTask(ctx, 'agent phase task');
    await writeStatusJson(taskId, baseStatus(taskId, { phase: 'work' }));
    await writeAlivePidFile();

    const result = await ctx.lazy(['list']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('working(agent)');
  });

  test('status shows working(agent) for an alive agent phase', async () => {
    const taskId = await makeWorkingTask(ctx, 'agent phase status');
    await writeStatusJson(taskId, baseStatus(taskId, { phase: 'work' }));
    await writeAlivePidFile();

    const result = await ctx.lazy(['status', taskId]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('working(agent)');
  });

  test('ls shows working(harness:post_turn_check ...) with the running command', async () => {
    const taskId = await makeWorkingTask(ctx, 'harness phase task');
    const startedAt = new Date(Date.now() - 3 * 60_000).toISOString(); // 3 minutes ago
    await writeStatusJson(taskId, baseStatus(taskId, {
      phase: 'post_turn_check',
      phase_started_at: startedAt,
      current_command: 'cargo build',
      current_command_started_at: startedAt,
    }));
    await writeAlivePidFile();

    const result = await ctx.lazy(['list']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('working(harness:post_turn_check');
    expect(result.stdout).toContain('cargo build');
  });

  test('status shows the harness phase for an alive post-turn phase', async () => {
    const taskId = await makeWorkingTask(ctx, 'harness phase status');
    const startedAt = new Date(Date.now() - 3 * 60_000).toISOString();
    await writeStatusJson(taskId, baseStatus(taskId, {
      phase: 'post_turn_check',
      phase_started_at: startedAt,
    }));
    await writeAlivePidFile();

    const result = await ctx.lazy(['status', taskId]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('working(harness:post_turn_check');
  });

  test('ls shows working(not-alive) when no run is alive and no response exists', async () => {
    const taskId = await makeWorkingTask(ctx, 'not-alive task');
    // status.json may reflect a stale phase, but with no live pid file and no
    // response.json the task is a stranded-completion candidate.
    await writeStatusJson(taskId, baseStatus(taskId, { phase: 'work' }));
    // Deliberately no pid file written → runner reports not running.

    const result = await ctx.lazy(['list']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('working(not-alive)');
    // The not-alive substate replaces the generic [CRASHED] suffix for working tasks.
    expect(result.stdout).not.toContain('[CRASHED]');
  });

  test('status shows working(not-alive) for a stranded working task', async () => {
    const taskId = await makeWorkingTask(ctx, 'not-alive status');
    await writeStatusJson(taskId, baseStatus(taskId, { phase: 'work' }));

    const result = await ctx.lazy(['status', taskId]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('working(not-alive)');
  });
});
