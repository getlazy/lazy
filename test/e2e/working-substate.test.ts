/**
 * E2E tests for working-substate observability.
 *
 * A task in `working` is otherwise opaque: a long post_turn_check, a hung
 * supervisor, and a dead supervisor all render identically. These tests assert
 * that `ls`/`status` surface the derived substate:
 *   - working(agent)            phase=work/start, run alive
 *   - working(agent:answering)  phase=work/ask, run alive (lazy ask turn)
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
import { protocolDir as getProtocolDir, writeWaitingFile, writeProgressFile, writeCommand } from '../../src/protocol';
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

  // INVARIANT: ask turns render as working(agent:answering) so it is
  // distinguishable from regular agent work across all read surfaces.
  test('ls shows working(agent:answering) when command_type=ask', async () => {
    const taskId = await makeWorkingTask(ctx, 'answering task');
    await writeStatusJson(taskId, baseStatus(taskId, { command_type: 'ask' }));
    await writeAlivePidFile();

    const result = await ctx.lazy(['list']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('working(agent:answering)');
  });

  // INVARIANT: a retrying task must say WHAT it is retrying. `harness:retrying`
  // with only a ticking elapsed counter is what sent a human to read supervisor
  // logs to find out the agent was being rate-limited.
  test('ls shows the attempt count and latest error for a retrying task', async () => {
    const taskId = await makeWorkingTask(ctx, 'retrying task');
    const startedAt = new Date(Date.now() - 47_000).toISOString();
    await writeStatusJson(taskId, baseStatus(taskId, {
      phase: 'retrying',
      phase_started_at: startedAt,
      retryCount: 7,
      retry_failure_class: 'transient_overload',
      errors: [{
        message: 'API Error: 529 overloaded',
        count: 7,
        firstSeen: startedAt,
        lastSeen: new Date().toISOString(),
      }],
    }));
    await writeAlivePidFile();

    const result = await ctx.lazy(['list']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('working(harness:retrying attempt 7 (transient_overload): API Error: 529 overloaded');
    // The old standalone "(retry 7)" suffix would now be a duplicate.
    expect(result.stdout).not.toContain('(retry 7)');
  });

  test('show renders the retry header and the retry state block', async () => {
    const taskId = await makeWorkingTask(ctx, 'retrying show task');
    const startedAt = new Date(Date.now() - 47_000).toISOString();
    await writeStatusJson(taskId, baseStatus(taskId, {
      phase: 'retrying',
      phase_started_at: startedAt,
      retryCount: 7,
      retry_failure_class: 'transient_overload',
      retry_failure_reason: 'API returned 529',
      retry_next_delay_ms: 30_000,
      errors: [{
        message: 'API Error: 529 overloaded',
        count: 7,
        firstSeen: startedAt,
        lastSeen: new Date().toISOString(),
      }],
    }));
    await writeAlivePidFile();

    const result = await ctx.lazy(['show', taskId]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('phase=retrying attempt 7 (transient_overload): API Error: 529 overloaded');
    expect(result.stdout).toContain('Retry Count:    7');
    expect(result.stdout).toContain('transient_overload — API returned 529');
    expect(result.stdout).toContain('Next Attempt:   in 30s');
  });

  // INVARIANT: an agent parked inside a blocking lazy tool call renders as
  // working(waiting on <task>), not working(agent). The marker is written by the
  // daemon from the authenticated MCP call — nothing here parses agent output.
  test('ls shows working(waiting on <task>) while a wait is in flight', async () => {
    const taskId = await makeWorkingTask(ctx, 'waiting task');
    await writeStatusJson(taskId, baseStatus(taskId, { phase: 'work' }));
    await writeWaitingFile(getProtocolDir(taskId), {
      version: 1,
      // The test process stands in for the daemon: readers only trust a marker
      // whose writing pid is alive.
      daemon_pid: process.pid,
      waits: [{
        id: 'w1',
        tool: 'lazy_wait',
        targets: ['child-task-id'],
        labels: ['fix-foo'],
        started_at: new Date(Date.now() - 2 * 60_000).toISOString(),
      }],
    });
    await writeAlivePidFile();

    const result = await ctx.lazy(['list']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('working(waiting on fix-foo');
  });

  test('status and show render the waiting substate too', async () => {
    const taskId = await makeWorkingTask(ctx, 'waiting status task');
    await writeStatusJson(taskId, baseStatus(taskId, { phase: 'work' }));
    await writeWaitingFile(getProtocolDir(taskId), {
      version: 1,
      daemon_pid: process.pid,
      waits: [{
        id: 'w1',
        tool: 'lazy_wait',
        targets: ['child-task-id'],
        labels: ['fix-foo'],
        started_at: new Date().toISOString(),
      }],
    });
    await writeAlivePidFile();

    const status = await ctx.lazy(['status', taskId]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain('working(waiting on fix-foo');

    const show = await ctx.lazy(['show', taskId]);
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain('waiting on fix-foo');
  });

  // INVARIANT: a marker left behind by a daemon that is no longer running is a
  // lie. Readers disbelieve it and fall back to the pre-existing substate.
  test('a wait marker from a dead daemon is ignored', async () => {
    const taskId = await makeWorkingTask(ctx, 'stale wait marker task');
    await writeStatusJson(taskId, baseStatus(taskId, { phase: 'work' }));
    await writeWaitingFile(getProtocolDir(taskId), {
      version: 1,
      daemon_pid: 2 ** 31 - 1, // no such process
      waits: [{
        id: 'w1',
        tool: 'lazy_wait',
        targets: ['child-task-id'],
        labels: ['fix-foo'],
        started_at: new Date().toISOString(),
      }],
    });
    await writeAlivePidFile();

    const result = await ctx.lazy(['list']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('working(agent)');
    expect(result.stdout).not.toContain('waiting on');
  });

  // A progress line posted with lazy_update_progress rides ALONGSIDE the substate:
  // `working(agent)` says the agent is alive, the line says what it is doing.
  test('ls and status show the agent-reported progress line', async () => {
    const taskId = await makeWorkingTask(ctx, 'progress task');
    await writeStatusJson(taskId, baseStatus(taskId, { phase: 'work' }));
    await writeProgressFile(getProtocolDir(taskId), {
      version: 1,
      writer_pid: process.pid,
      message: 'running migration 3/7',
      recorded_at: new Date().toISOString(),
    });
    await writeAlivePidFile();

    const list = await ctx.lazy(['list']);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain('working(agent: running migration 3/7)');

    const status = await ctx.lazy(['status', taskId]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain('working(agent: running migration 3/7)');
  });

  // INVARIANT: same tripwire as the wait marker — a progress line whose writer is
  // gone is a claim about a turn that is over, so readers disbelieve it.
  test('a progress marker from a dead writer is ignored', async () => {
    const taskId = await makeWorkingTask(ctx, 'stale progress task');
    await writeStatusJson(taskId, baseStatus(taskId, { phase: 'work' }));
    await writeProgressFile(getProtocolDir(taskId), {
      version: 1,
      writer_pid: 2 ** 31 - 1, // no such process
      message: 'running migration 3/7',
      recorded_at: new Date().toISOString(),
    });
    await writeAlivePidFile();

    const result = await ctx.lazy(['list']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('working(agent)');
    expect(result.stdout).not.toContain('running migration');
  });

  // INVARIANT: a new turn starts with no progress. Clearing happens inside
  // writeCommand — the one place every turn passes through — so a message from a
  // finished turn structurally cannot linger into the next one.
  test('starting a new turn clears the previous turn\'s progress line', async () => {
    const taskId = await makeWorkingTask(ctx, 'progress cleared task');
    await writeStatusJson(taskId, baseStatus(taskId, { phase: 'work' }));
    await writeProgressFile(getProtocolDir(taskId), {
      version: 1,
      writer_pid: process.pid,
      message: 'running migration 3/7',
      recorded_at: new Date().toISOString(),
    });
    await writeAlivePidFile();

    expect((await ctx.lazy(['list'])).stdout).toContain('running migration 3/7');

    writeCommand(getProtocolDir(taskId), {
      type: 'start',
      task_id: taskId,
      goal: 'progress cleared task',
      prompt: 'next turn',
    });

    const after = await ctx.lazy(['list']);
    expect(after.exitCode).toBe(0);
    expect(after.stdout).toContain('working(agent)');
    expect(after.stdout).not.toContain('running migration');
  });

  test('status shows working(agent:answering) for an ask-phase task', async () => {
    const taskId = await makeWorkingTask(ctx, 'answering status');
    await writeStatusJson(taskId, baseStatus(taskId, { command_type: 'ask' }));
    await writeAlivePidFile();

    const result = await ctx.lazy(['status', taskId]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('working(agent:answering)');
  });
});
