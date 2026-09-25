/**
 * A host run record identifies a SUPERVISOR, not just a pid.
 *
 * `~/.lazy/run` is one flat, global directory keyed only by run name, and a run
 * name is `lazy-<task ref>` — the task's CODE for every task a human creates.
 * So the same record can be answered by a process that has nothing to do with
 * the task: another project's supervisor for a task with the same code, or
 * whatever the OS handed the recycled pid to. Whoever asks `isRunning()` then
 * gets a confident yes, the launcher takes the "supervisor already running, it
 * will pick up the command" branch, and the task sits in `working` forever.
 *
 * The defense is that the record names the worktree its supervisor was launched
 * against, and liveness is checked against the running process's command line.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { HostProcessRunner } from '../../src/runner/host-process-runner';

const runDir = (home: string) => join(home, '.lazy', 'run');

async function writeRunRecord(
  home: string,
  runName: string,
  data: { pid: number; worktree?: string },
): Promise<void> {
  await mkdir(runDir(home), { recursive: true });
  await writeFile(
    join(runDir(home), `${runName}.json`),
    JSON.stringify({
      pid: data.pid,
      startedAt: new Date().toISOString(),
      logFile: '/dev/null',
      ...(data.worktree ? { worktree: data.worktree } : {}),
    }),
  );
}

describe('host run records are verified, not just read', () => {
  let home: string;
  let originalHome: string | undefined;
  let victims: number[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'lazy-run-identity-'));
    originalHome = process.env.HOME;
    process.env.HOME = home;
    victims = [];
  });

  afterEach(async () => {
    for (const pid of victims) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    await rm(home, { recursive: true, force: true });
  });

  function spawnForeignProcess(): number {
    const proc = Bun.spawn(['sleep', '3600'], { stdout: 'ignore', stderr: 'ignore' });
    victims.push(proc.pid);
    return proc.pid;
  }

  // INVARIANT: a live pid alone does not make a run "running". The recorded
  // worktree has to show up in the process's command line.
  test('a live but foreign pid does not answer for the run name', async () => {
    const runner = new HostProcessRunner();
    const pid = spawnForeignProcess();
    await writeRunRecord(home, 'lazy-fix-login', {
      pid,
      worktree: '/some/other/project/.lazy/worktrees/fix-login',
    });

    expect(await runner.isRunning('lazy-fix-login')).toBe(false);
    // …and the record is gone, so it cannot wedge the next launch either.
    expect(existsSync(join(runDir(home), 'lazy-fix-login.json'))).toBe(false);
  });

  // INVARIANT: never signal a pid we could not confirm is ours. A supervisor's
  // stop must not become "kill whatever holds that number now".
  test('stopRun refuses a record whose pid is not our supervisor', async () => {
    const runner = new HostProcessRunner();
    const pid = spawnForeignProcess();
    await writeRunRecord(home, 'lazy-fix-login', { pid, worktree: '/gone/worktree' });

    expect(await runner.stopRun('lazy-fix-login')).toBe(false);
    // The innocent process is untouched.
    expect(() => process.kill(pid, 0)).not.toThrow();
  });

  // INVARIANT: records written before the worktree field existed keep the old
  // liveness-only behavior — they cannot be checked, and calling them foreign
  // would launch a second supervisor for a task that already has one.
  test('a legacy record with no recorded worktree is believed on liveness', async () => {
    const runner = new HostProcessRunner();
    const pid = spawnForeignProcess();
    await writeRunRecord(home, 'lazy-legacy', { pid });

    expect(await runner.isRunning('lazy-legacy')).toBe(true);
  });

  // A verifiable record whose process really is the supervisor stays running:
  // the check must not be a blanket "delete everything".
  test('a record whose command line matches the worktree is running', async () => {
    const runner = new HostProcessRunner();
    // `sleep` will not do here — the check reads the command line, so the
    // worktree has to appear in it. A shell sleeping with the path as an
    // argument stands in for `lazy supervise --worktree <path>`.
    const worktree = join(home, 'worktrees', 'fix-login');
    const proc = Bun.spawn(['sh', '-c', `sleep 3600 # --worktree ${worktree}`], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    victims.push(proc.pid);
    await writeRunRecord(home, 'lazy-fix-login', { pid: proc.pid, worktree });

    expect(await runner.isRunning('lazy-fix-login')).toBe(true);
  });
});
