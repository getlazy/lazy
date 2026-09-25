/**
 * Behavior tests for the PID-1 wrapper script (buildSupervisorWrapperScript).
 *
 * INVARIANT (remove-reaper-cap-sweep): the wrapper does NOT kill other
 * processes between turns. The old between-turn sweep (SIGTERM to every pid,
 * 1s, SIGKILL) was removed by explicit engineer decision (2026-08-14): a
 * process the agent leaves running — a dev server, a database — survives the
 * turn boundary, and the CONTAINER is the cleanup boundary (everything dies
 * with the task's terminal cleanup / stop, which still `docker kill`s it).
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
    const stub = join(bin, 'lazy-agent');
    await writeFile(stub, `#!/bin/sh\n${body}\n`);
    await chmod(stub, 0o755);
    return bin;
  }

  test('a process started in one turn is still alive after the turn boundary', async () => {
    // Turn 1: start a background process and record its pid, exit 0 (turn done
    // → wrapper loops into turn 2). Turn 2: report whether that pid is still
    // alive, exit 42 (stop → wrapper exits 0).
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
    // And the exit-code protocol still holds: 42 (stop) → wrapper exits 0.
    expect(exitCode).toBe(0);
    // The survivor is still running even after the wrapper itself exited.
    expect(() => process.kill(survivorPid!, 0)).not.toThrow();
  });

  test('a non-zero, non-42 supervisor exit still ends the wrapper with that code', async () => {
    const bin = await writeStubAgent('exit 7');
    const script = buildSupervisorWrapperScript(join(root, 'proto'), root);
    const proc = spawn(['sh', '-c', script], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    });
    expect(await proc.exited).toBe(7);
  });

  test('the wrapper script contains no between-turn kill sweep', () => {
    // Belt-and-braces alongside the behavioral test: the generated script must
    // not walk /proc or signal arbitrary pids between turns. The only `kill`
    // allowed is the TERM/INT trap forwarding to the supervisor child.
    const script = buildSupervisorWrapperScript('/proto', '/wt');
    expect(script).not.toContain('/proc/');
    expect(script).not.toContain('kill -9');
  });
});
