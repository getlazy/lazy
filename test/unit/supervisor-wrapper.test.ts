/**
 * Behavior tests for the PID-1 wrapper script (buildSupervisorWrapperScript).
 *
 * INVARIANT (remove-reaper-cap-sweep): the wrapper does NOT kill other
 * processes between turns. The old between-turn sweep (SIGTERM to every pid,
 * 1s, SIGKILL) was removed by explicit engineer decision (2026-08-14): a
 * process the agent leaves running — a dev server, a database — survives the
 * turn boundary, and the CONTAINER is the cleanup boundary (everything dies
 * with the task's terminal cleanup or explicit environment replacement).
 *
 * These tests run the real generated sh script with a scripted stand-in for
 * `lazy-agent` on PATH, so they exercise the wrapper's actual restart loop and
 * exit-code protocol — not a string match on its source. (Running the OLD
 * wrapper this way was impossible: its sweep killed every process on the host
 * test machine, not just container processes, because it was written for a
 * PID-1 world. The fact that this test can exist at all is the new posture.)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile, mkdir, chmod } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from '../../src/utils/spawn';
import { buildSupervisorWrapperScript } from '../../src/capture/claude';
import { STOP_TASK_AGENT_SCRIPT } from '../../src/runner/stop-task-agent';

describe('supervisor wrapper (between-turn behavior)', () => {
  let root: string;
  let survivorPid: number | null = null;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-wrapper-'));
  });

  afterEach(async () => {
    // Reap the deliberately-surviving background process.
    if (survivorPid !== null) {
      try { process.kill(survivorPid, 'SIGKILL'); } catch { /* already gone */ }
      survivorPid = null;
    }
    await rm(root, { recursive: true, force: true });
  });

  async function writeStubAgent(body: string): Promise<string> {
    const bin = join(root, 'bin');
    await mkdir(bin, { recursive: true });
    await mkdir(join(root, 'proto'), { recursive: true });
    const stub = join(bin, 'lazy-agent');
    await writeFile(stub, `#!/bin/sh\n[ "$1" = supervisor-exit ] && exit 0\n${body}\n`);
    await chmod(stub, 0o755);
    return bin;
  }

  test('a process started in one turn is still alive after the turn boundary', async () => {
    // Turn 1: start a background process and record its pid, exit 0 (turn done
    // → wrapper loops into turn 2). Turn 2: report whether that pid is still
    // alive, then explicitly terminate the wrapper.
    const pidFile = join(root, 'survivor.pid');
    const verdictFile = join(root, 'verdict');
    const turnFile = join(root, 'turn');
    const bin = await writeStubAgent(
      [
        `if [ ! -f "${turnFile}" ]; then`,
        `  touch "${turnFile}"`,
        `  sleep 300 &`,
        `  echo $! > "${pidFile}"`,
        `  exit 0`,
        `fi`,
        `if kill -0 "$(cat "${pidFile}")" 2>/dev/null; then echo alive > "${verdictFile}"; else echo dead > "${verdictFile}"; fi`,
        `kill -TERM "$PPID"`,
        `exit 42`,
      ].join('\n'),
    );

    const script = buildSupervisorWrapperScript(join(root, 'proto'), root);
    const proc = spawn(['sh', '-c', script], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    });
    const exitCode = await proc.exited;

    survivorPid = parseInt((await readFile(pidFile, 'utf-8')).trim(), 10);
    const verdict = (await readFile(verdictFile, 'utf-8')).trim();

    // The survivor crossed the turn boundary alive — nothing swept it.
    expect(verdict).toBe('alive');
    // Only the explicit TERM to the environment wrapper ends it.
    expect(exitCode).toBe(0);
    // The survivor is still running even after the wrapper itself exited.
    expect(() => process.kill(survivorPid!, 0)).not.toThrow();
  });

  // INVARIANT: failed, killed and stopped turns end only their supervisor.
  // Killing the wrapper here explicitly stands in for environment teardown.
  for (const code of [1, 7, 42, 137]) {
    test(`exit ${code} keeps the environment and restarts the supervisor`, async () => {
      const path = join(root, 'invocations');
      const bin = await writeStubAgent(`echo invoked >> "${path}"
if [ "$(wc -l < "${path}")" -eq 1 ]; then exit ${code}; fi
kill -TERM "$PPID"
exit 0`);
      const proc = spawn(['sh', '-c', buildSupervisorWrapperScript(join(root, 'proto'), root)], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
      });
      expect(await proc.exited).toBe(0);
      expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(2);
    });
  }

  test('the wrapper script contains no between-turn kill sweep', () => {
    // Belt-and-braces alongside the behavioral test: the generated script must
    // not walk /proc or signal arbitrary pids between turns. The only `kill`
    // allowed is the TERM/INT trap forwarding to the supervisor child.
    const script = buildSupervisorWrapperScript('/proto', '/wt');
    expect(script).not.toContain('/proc/');
    expect(script).not.toContain('kill -9');
  });

  // INVARIANT: repeated supervisor failures back off rather than burning a
  // core, while the environment and its services stay alive.
  test('repeated crashes wait progressively longer', async () => {
    const path = join(root, 'crashes');
    const bin = await writeStubAgent(`date +%s >> "${path}"
if [ "$(wc -l < "${path}")" -ge 3 ]; then kill -TERM "$PPID"; exit 0; fi
exit 1`);
    const proc = spawn(['sh', '-c', buildSupervisorWrapperScript(join(root, 'proto'), root)], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
    });
    expect(await proc.exited).toBe(0);
    const times = (await readFile(path, 'utf8')).trim().split('\n').map(Number);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(2);
  });

  // INVARIANT: Stop ends the harness, not a service the harness started. A
  // recursive process-tree kill would silently destroy that service too.
  test('stopping a turn preserves services descended from its harness', async () => {
    const pidFile = join(root, 'service.pid');
    const harness = join(root, 'harness');
    await writeFile(harness, `#!/bin/sh\nsleep 300 &\necho $! > "${pidFile}"\nwait\n`);
    await chmod(harness, 0o755);
    const bin = await writeStubAgent(`if [ ! -f "${pidFile}" ]; then "${harness}" & wait; else exec sleep 300; fi`);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const proc = spawn(['sh', '-c', buildSupervisorWrapperScript(join(root, 'proto'), root)], {
      env, stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
    });
    try {
      const deadline = Date.now() + 5_000;
      while (!await Bun.file(pidFile).exists()) {
        if (Date.now() > deadline) throw new Error('Harness did not start its service');
        await Bun.sleep(20);
      }
      survivorPid = Number(await readFile(pidFile, 'utf8'));
      const stop = spawn(['sh', '-c', STOP_TASK_AGENT_SCRIPT, 'stop-task-agent', join(root, 'proto')], {
        env, stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
      });
      expect(await stop.exited).toBe(0);
      expect(() => process.kill(survivorPid!, 0)).not.toThrow();
    } finally {
      proc.kill('SIGTERM');
      await proc.exited;
    }
  }, 30_000);

  // INVARIANT: Stop cancels a queued turn even while the wrapper is backing
  // off. A replacement supervisor's PID is not proof that the turn stopped.
  test('Stop during backoff cancels the queued turn before acknowledging', async () => {
    const proto = join(root, 'proto');
    const ran = join(root, 'cancelled-turn-ran');
    const bin = await writeStubAgent(`if [ ! -f "${root}/first" ]; then touch "${root}/first"; exit 1; fi
while [ ! -f "${proto}/command.json" ]; do sleep 0.1; done
echo ran > "${ran}"
rm "${proto}/command.json"
exec sleep 300`);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const log = join(root, 'wrapper.log');
    const proc = spawn(['sh', '-c', buildSupervisorWrapperScript(proto, root)], {
      env, stdout: 'ignore', stderr: Bun.file(log), timeout: 15_000,
    });
    try {
      const deadline = Date.now() + 5_000;
      while (!(await readFile(log, 'utf8').catch(() => '')).includes('retrying in 1s')) {
        if (Date.now() > deadline) throw new Error('Wrapper did not enter backoff');
        await Bun.sleep(20);
      }
      await writeFile(join(proto, 'command.json'), '{}');
      const stop = spawn(['sh', '-c', STOP_TASK_AGENT_SCRIPT, 'stop-task-agent', proto], {
        env, stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
      });
      expect(await stop.exited).toBe(0);
      expect(await Bun.file(ran).exists()).toBe(false);
      expect(await Bun.file(join(proto, 'command.json')).exists()).toBe(false);
      expect(() => process.kill(proc.pid, 0)).not.toThrow();
    } finally {
      proc.kill('SIGTERM');
      await proc.exited;
    }
  }, 30_000);
});
