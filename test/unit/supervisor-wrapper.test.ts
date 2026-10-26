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
import { AGENT_RESTART_MARKER, SUPERVISOR_PID_FILE } from '../../src/runner/agent-stop';
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

/**
 * INVARIANT: a supervisor the DAEMON stopped on purpose is restarted by the
 * wrapper at once, so the container — and the services in its tmux sessions —
 * survive a daemon restart (src/runner/agent-stop.ts). Such a stop is not a
 * crash: no crash receipt is written and no backoff is taken. Any other
 * non-zero exit is a crash, which (since the container outlives failed turns)
 * also keeps the wrapper but reports and backs off; the marker is cleared on
 * every exit, so one stop never turns a later crash into a silent restart.
 *
 * Merge note (next-release-20261020 ← main): this suite used to assert that a
 * crash without the marker ENDS the wrapper. main deliberately keeps the
 * container on every failed turn, so those assertions now check that a crash
 * is reported (receipt) and backed off instead.
 */
describe('supervisor wrapper (daemon-requested agent restart)', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'lazy-wrapper-restart-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  // The body runs as one supervisor; it ends the wrapper with `stop`.
  async function run(body: string): Promise<{ code: number | null; invocations: number; receipts: number; backoffs: number }> {
    const bin = join(root, 'bin');
    await mkdir(bin, { recursive: true });
    await mkdir(join(root, 'proto'), { recursive: true });
    await writeFile(join(bin, 'lazy-agent'), [
      '#!/bin/sh',
      `if [ "$1" = supervisor-exit ]; then echo r >> "${root}/receipts"; exit 0; fi`,
      `echo x >> "${root}/invocations"`,
      'stop() { kill -TERM "$PPID"; exit 0; }',
      body,
    ].join('\n'));
    await chmod(join(bin, 'lazy-agent'), 0o755);
    const script = buildSupervisorWrapperScript(join(root, 'proto'), root)
      .replaceAll(AGENT_RESTART_MARKER, join(root, 'restart-marker'))
      .replaceAll(SUPERVISOR_PID_FILE, join(root, 'supervisor.pid'));
    const proc = spawn(['sh', '-c', script], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
    });
    const stderrRead = new Response(proc.stderr).text();
    const code = await proc.exited;
    const stderr = await stderrRead;
    const lines = async (name: string) =>
      (await readFile(join(root, name), 'utf-8').catch(() => '')).trim().split('\n').filter(Boolean).length;
    return {
      code,
      invocations: await lines('invocations'),
      receipts: await lines('receipts'),
      backoffs: stderr.split('\n').filter((l) => l.includes('retrying in')).length,
    };
  }

  test('a supervisor stopped with the restart marker is started again at once, not as a crash', async () => {
    const started = Date.now();
    const result = await run([
      `if [ ! -f "${root}/once" ]; then touch "${root}/once"; echo $$ > "${root}/restart-marker"; exit 143; fi`,
      'stop',
    ].join('\n'));
    expect(result).toEqual({ code: 0, invocations: 2, receipts: 0, backoffs: 0 });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('the wrapper records the running supervisor\'s pid for the agent stop', async () => {
    const result = await run(`cat "${root}/supervisor.pid" > "${root}/seen-pid"; echo $$ > "${root}/own-pid"; stop`);
    expect(result.code).toBe(0);
    expect((await readFile(join(root, 'seen-pid'), 'utf-8')).trim()).toBe((await readFile(join(root, 'own-pid'), 'utf-8')).trim());
  });

  test('without the marker a signal death is a crash, and one marker covers one exit only', async () => {
    expect(await run([
      `if [ ! -f "${root}/once" ]; then touch "${root}/once"; exit 143; fi`,
      'stop',
    ].join('\n'))).toEqual({ code: 0, invocations: 2, receipts: 1, backoffs: 1 });
    for (const f of ['invocations', 'receipts', 'once', 'twice']) await rm(join(root, f), { force: true });
    // Marker on the first exit only: the second exit is a crash.
    expect(await run([
      `if [ ! -f "${root}/once" ]; then touch "${root}/once"; echo $$ > "${root}/restart-marker"; exit 143; fi`,
      `if [ ! -f "${root}/twice" ]; then touch "${root}/twice"; exit 9; fi`,
      'stop',
    ].join('\n'))).toEqual({ code: 0, invocations: 3, receipts: 1, backoffs: 1 });
  });

  // INVARIANT: the restart marker names the supervisor it is for. A marker
  // left for another supervisor (a stop whose target died on its own, a stale
  // file from an earlier run) must not turn a real crash into a silent restart.
  test('a marker holding another supervisor\'s pid does not hide a crash', async () => {
    const result = await run([
      `if [ ! -f "${root}/once" ]; then touch "${root}/once"; echo 1 > "${root}/restart-marker"; exit 9; fi`,
      'stop',
    ].join('\n'));
    expect(result).toEqual({ code: 0, invocations: 2, receipts: 1, backoffs: 1 });
  });
});
